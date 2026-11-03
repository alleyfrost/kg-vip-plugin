const PLUGIN_TAG = '[kg-vip-checkin]';
const BEIJING_TZ = 'Asia/Shanghai';
const SETTINGS_KEY = 'settings';
const LAST_SUCCESS_KEY = 'checkin.lastSuccessDate';
const LAST_ATTEMPT_KEY = 'checkin.lastAttemptDate';
const LAST_RESULT_KEY = 'checkin.lastResult';
const AUTO_DELAY_MS = 3000;
const LOGIN_RETRY_COUNT = 5;
const LOGIN_RETRY_DELAY_MS = 3000;

let currentRuntime = null;
let activeRun = null;

export function shanghaiDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BEIJING_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

function createRuntime() {
  const timers = new Set();
  let disposed = false;
  return {
    get disposed() {
      return disposed;
    },
    sleep(ms) {
      if (disposed) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          timers.delete(timer);
          resolve();
        }, ms);
        timers.add(timer);
      });
    },
    dispose() {
      disposed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}

function formatDateTime(timestamp, withTime = true) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return String(timestamp);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BEIJING_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value || '';
  const day = `${pick('year')}-${pick('month')}-${pick('day')}`;
  return withTime ? `${day} ${pick('hour')}:${pick('minute')}` : day;
}

function formatExpiry(value) {
  if (value === undefined || value === null || value === '') return '';
  const text = String(value);
  if (/^\d{10,13}$/.test(text)) {
    const numeric = Number(text);
    return formatDateTime(numeric < 1e12 ? numeric * 1000 : numeric);
  }
  return text;
}

function responseBody(error) {
  const response = error && typeof error === 'object' ? error.response : null;
  const body = response && typeof response === 'object' ? response.body : null;
  return body && typeof body === 'object' ? body : null;
}

function bodyMessage(body) {
  if (!body) return '';
  const direct = body.msg ?? body.message ?? body.error;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const data = body.data;
  if (data && typeof data === 'object') {
    const nested = data.msg ?? data.message;
    if (typeof nested === 'string' && nested.trim()) return nested.trim();
  }
  return '';
}

function errorCode(body) {
  if (!body) return undefined;
  const code = body.error_code ?? body.errcode ?? body.err_code;
  return code === undefined || code === null ? undefined : Number(code);
}

function describeError(error) {
  const body = responseBody(error);
  if (body) {
    const message = bodyMessage(body);
    if (message) return message;
    const code = errorCode(body);
    if (code !== undefined && Number.isFinite(code)) return `错误码 ${code}`;
  }
  const status = error?.response?.status;
  if (status) return `请求失败（HTTP ${status}）`;
  return error?.message ? String(error.message) : String(error);
}

function isAuthExpired(body) {
  if (!body) return false;
  if (errorCode(body) === 20018) return true;
  return /登录已过期|请重新登录|未登录/.test(bodyMessage(body));
}

function isAlreadyClaimed(body) {
  if (!body) return false;
  const code = errorCode(body);
  // 131001 为 /youth/day/vip 当天已领取的返回码（上游作者确认）
  if (code === 131001 || code === 30002 || code === 130012 || code === 130013) return true;
  return /已(经)?(领取|签到|签)|重复领取|今日.*已/.test(bodyMessage(body));
}

function isSuccessfulPayload(body) {
  if (!body || typeof body !== 'object') return false;
  const status = Number(body.status);
  if (Number.isFinite(status) && Object.prototype.hasOwnProperty.call(body, 'status')) {
    return status === 1;
  }
  const code = errorCode(body);
  return code === undefined || code === 0;
}

function interpretClaim(body) {
  if (isSuccessfulPayload(body)) {
    return { ok: true, already: false, message: bodyMessage(body) || '领取成功' };
  }
  if (isAlreadyClaimed(body)) {
    return { ok: true, already: true, message: bodyMessage(body) || '今日已领取' };
  }
  return { ok: false, message: bodyMessage(body) || '领取失败' };
}

function interpretUpgrade(body) {
  if (isSuccessfulPayload(body)) {
    return { ok: true, message: bodyMessage(body) || '升级成功' };
  }
  const message = bodyMessage(body);
  if (isAlreadyClaimed(body) || /已升级|无需升级/.test(message)) {
    return { ok: true, message: message || '已升级' };
  }
  return { ok: false, message: message || '升级失败' };
}

function extractExpiry(body) {
  const data = body && typeof body === 'object' ? body.data : null;
  if (!data || typeof data !== 'object') return '';
  if (Array.isArray(data.busi_vip)) {
    for (const item of data.busi_vip) {
      if (!item || typeof item !== 'object') continue;
      const value = item.vip_end_time ?? item.end_time ?? item.expire_time;
      const formatted = formatExpiry(value);
      if (formatted) return formatted;
    }
  }
  for (const key of ['vip_end_time', 'end_time', 'expire_time']) {
    const formatted = formatExpiry(data[key]);
    if (formatted) return formatted;
  }
  return '';
}

async function readSettings(ctx) {
  const stored = await ctx.storage.get(SETTINGS_KEY);
  return {
    ...(stored && typeof stored === 'object' ? stored : {}),
    autoCheckin: !(stored && typeof stored === 'object' && stored.autoCheckin === false),
  };
}

async function readExpiry(ctx) {
  try {
    return extractExpiry(await ctx.kugou.user.getUserVipDetail());
  } catch (error) {
    console.warn(PLUGIN_TAG, '读取 VIP 到期时间失败', error);
    return '';
  }
}

function isLoggedIn(body) {
  if (!body || typeof body !== 'object') return false;
  const data = body.data;
  if (!data || typeof data !== 'object') return false;
  return data.nickname != null || data.userid != null || data.user_id != null;
}

async function waitForLogin(ctx, runtime) {
  for (let attempt = 0; attempt < LOGIN_RETRY_COUNT; attempt += 1) {
    if (runtime.disposed) return false;
    try {
      if (isLoggedIn(await ctx.kugou.user.getUserDetail())) return true;
    } catch (error) {
      if (isAuthExpired(responseBody(error))) return false;
    }
    if (attempt < LOGIN_RETRY_COUNT - 1) await runtime.sleep(LOGIN_RETRY_DELAY_MS);
  }
  return false;
}

async function writeFailure(ctx, today, message) {
  await ctx.storage.set(LAST_RESULT_KEY, {
    date: today,
    at: Date.now(),
    ok: false,
    message,
  });
}

async function executeCheckIn(ctx, runtime, manual) {
  const today = shanghaiDateKey();
  const lastSuccess = await ctx.storage.get(LAST_SUCCESS_KEY);
  if (lastSuccess === today) {
    if (manual) ctx.toast.info('今天已经签到过了');
    return { skipped: true, reason: 'already-done' };
  }
  if (!manual && (await ctx.storage.get(LAST_ATTEMPT_KEY)) === today) {
    return { skipped: true, reason: 'attempted' };
  }
  if (runtime.disposed) return { skipped: true, reason: 'disposed' };

  await ctx.storage.set(LAST_ATTEMPT_KEY, today);

  let claim;
  try {
    claim = interpretClaim(await ctx.kugou.user.claimDayVip(today));
  } catch (error) {
    if (runtime.disposed) return { skipped: true, reason: 'disposed' };
    // 业务失败会以 HTTP 502 抛出，需从 error.response.body 里识别“今日已领取”
    const body = responseBody(error);
    if (isAlreadyClaimed(body)) {
      claim = { ok: true, already: true, message: bodyMessage(body) || '今日已领取' };
    } else {
      const message = isAuthExpired(body)
        ? '登录已过期，请重新登录'
        : describeError(error);
      await writeFailure(ctx, today, message);
      ctx.toast.warning(message);
      return { ok: false, message };
    }
  }

  if (!claim.ok) {
    await writeFailure(ctx, today, claim.message);
    ctx.toast.danger(`签到失败：${claim.message}`);
    return { ok: false, message: claim.message };
  }

  let upgrade = { ok: false, message: '未执行' };
  try {
    upgrade = interpretUpgrade(await ctx.kugou.user.upgradeDayVip());
  } catch (error) {
    const body = responseBody(error);
    const parsed = body ? interpretUpgrade(body) : null;
    upgrade = parsed && parsed.ok ? parsed : { ok: false, message: describeError(error) };
  }

  const expiry = await readExpiry(ctx);
  if (runtime.disposed) return { skipped: true, reason: 'disposed' };

  await ctx.storage.set(LAST_SUCCESS_KEY, today);
  await ctx.storage.set(LAST_RESULT_KEY, {
    date: today,
    at: Date.now(),
    ok: true,
    already: claim.already,
    claim: claim.message,
    upgrade: upgrade.message,
    upgradeOk: upgrade.ok,
    expiry,
  });

  const headline = claim.already ? '今日 VIP 已领取' : '签到成功';
  const expiryText = expiry ? `，VIP 到期 ${expiry}` : '';
  const upgradeText = upgrade.ok ? '' : `；升级未完成：${upgrade.message}`;
  if (claim.already) ctx.toast.info(`${headline}${expiryText}`);
  else ctx.toast.success(`${headline}${expiryText}${upgradeText}`);

  return { ok: true, already: claim.already, expiry, upgrade };
}

export async function runCheckIn(ctx, options = {}) {
  if (activeRun) return activeRun;
  const runtime = options.runtime || currentRuntime || createRuntime();
  activeRun = (async () => {
    try {
      return await executeCheckIn(ctx, runtime, Boolean(options.manual));
    } finally {
      activeRun = null;
    }
  })();
  return activeRun;
}

async function bootstrap(ctx, runtime) {
  try {
    const settings = await readSettings(ctx);
    if (!settings.autoCheckin) return;
    const today = shanghaiDateKey();
    if ((await ctx.storage.get(LAST_SUCCESS_KEY)) === today) return;
    if ((await ctx.storage.get(LAST_ATTEMPT_KEY)) === today) return;
    await runtime.sleep(AUTO_DELAY_MS);
    if (runtime.disposed) return;
    if (!(await waitForLogin(ctx, runtime))) {
      if (!runtime.disposed) ctx.toast.info('未登录酷狗账号，已跳过自动签到');
      return;
    }
    await runCheckIn(ctx, { runtime });
  } catch (error) {
    console.warn(PLUGIN_TAG, '自动签到流程异常', error);
  }
}

function resultSummary(result) {
  if (!result) return '今天还没有执行过签到';
  if (result.ok) {
    const parts = [result.already ? '今日已领取' : '领取成功'];
    if (result.upgrade) parts.push(`升级：${result.upgrade}`);
    if (result.expiry) parts.push(`到期 ${result.expiry}`);
    return parts.join(' · ');
  }
  return `上次失败：${result.message || '未知错误'}`;
}

function installStyles(ctx) {
  ctx.css.inject(
    `
.kg-vip-panel { display: flex; flex-direction: column; gap: 14px; color: var(--color-text-main, inherit); }
.kg-vip-status-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 16px; border-radius: 12px; background: color-mix(in srgb, var(--color-primary, #22a06b) 9%, transparent); border: 1px solid color-mix(in srgb, var(--color-primary, #22a06b) 24%, transparent); }
.kg-vip-status-title { font-size: 15px; font-weight: 600; }
.kg-vip-status-sub { margin-top: 4px; font-size: 12px; opacity: 0.68; }
.kg-vip-meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.kg-vip-meta-item { padding: 10px 12px; border-radius: 10px; background: var(--control-muted-bg, rgba(127, 127, 127, 0.08)); }
.kg-vip-meta-label { font-size: 12px; opacity: 0.62; }
.kg-vip-meta-value { margin-top: 4px; font-size: 14px; font-weight: 600; word-break: break-all; }
.kg-vip-switch-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding-top: 4px; }
.kg-vip-switch-title { font-size: 14px; font-weight: 500; }
.kg-vip-switch-sub { margin-top: 3px; font-size: 12px; opacity: 0.62; }
.kg-vip-button { padding: 7px 14px; border-radius: 8px; border: 1px solid var(--color-primary, #22a06b); background: color-mix(in srgb, var(--color-primary, #22a06b) 16%, transparent); color: inherit; font: inherit; cursor: pointer; }
.kg-vip-button:disabled { opacity: 0.55; cursor: not-allowed; }
`,
    { id: 'kg-vip-checkin-style' },
  );
}

function installSettings(ctx) {
  const { h, defineComponent, ref, computed, onMounted, defineAsyncComponent } = ctx.vue;
  const HostButton = ctx.ui.components?.Button
    ? defineAsyncComponent(ctx.ui.components.Button)
    : null;
  const HostSwitch = ctx.ui.components?.Switch
    ? defineAsyncComponent(ctx.ui.components.Switch)
    : null;

  const renderButton = (label, onClick, loading, disabled) =>
    HostButton
      ? h(
          HostButton,
          {
            variant: 'primary',
            size: 'sm',
            loading,
            disabled: loading || disabled,
            onClick,
          },
          () => label,
        )
      : h(
          'button',
          { class: 'kg-vip-button', disabled: loading || disabled, onClick },
          label,
        );

  const renderSwitch = (value, onChange) =>
    HostSwitch
      ? h(HostSwitch, {
          modelValue: value,
          'onUpdate:modelValue': (next) => void onChange(next),
        })
      : h('input', {
          type: 'checkbox',
          checked: value,
          onChange: (event) => void onChange(event.target.checked),
        });

  const SettingsPanel = defineComponent({
    name: 'KgVipCheckinSettings',
    setup() {
      const running = ref(Boolean(activeRun));
      const autoCheckin = ref(true);
      const today = ref(shanghaiDateKey());
      const lastSuccess = ref('');
      const lastResult = ref(null);
      const feedback = ref('');
      const doneToday = computed(() => lastSuccess.value === today.value);

      const refresh = async () => {
        const settings = await readSettings(ctx);
        autoCheckin.value = settings.autoCheckin;
        today.value = shanghaiDateKey();
        lastSuccess.value = (await ctx.storage.get(LAST_SUCCESS_KEY)) || '';
        lastResult.value = (await ctx.storage.get(LAST_RESULT_KEY)) || null;
      };

      const toggleAuto = async (value) => {
        autoCheckin.value = Boolean(value);
        const settings = await readSettings(ctx);
        await ctx.storage.set(SETTINGS_KEY, {
          ...settings,
          autoCheckin: autoCheckin.value,
        });
      };

      const run = async () => {
        if (running.value) return;
        running.value = true;
        feedback.value = '';
        try {
          const result = await runCheckIn(ctx, { manual: true });
          if (result?.ok) feedback.value = result.already ? '今日已领取' : '签到完成';
          else if (result?.message) feedback.value = result.message;
          else if (result?.skipped) feedback.value = '本次未执行';
        } catch (error) {
          feedback.value = describeError(error);
        } finally {
          running.value = false;
          await refresh();
        }
      };

      onMounted(() => {
        void refresh();
      });

      return () =>
        h('div', { class: 'kg-vip-panel' }, [
          h('div', { class: 'kg-vip-status-row' }, [
            h('div', {}, [
              h(
                'div',
                { class: 'kg-vip-status-title' },
                doneToday.value ? '今日已签到' : '今日未签到',
              ),
              h(
                'div',
                { class: 'kg-vip-status-sub' },
                feedback.value || resultSummary(lastResult.value),
              ),
            ]),
            renderButton('立即签到', run, running.value, doneToday.value),
          ]),
          h('div', { class: 'kg-vip-meta' }, [
            h('div', { class: 'kg-vip-meta-item' }, [
              h('div', { class: 'kg-vip-meta-label' }, 'VIP 到期'),
              h('div', { class: 'kg-vip-meta-value' }, lastResult.value?.expiry || '—'),
            ]),
            h('div', { class: 'kg-vip-meta-item' }, [
              h('div', { class: 'kg-vip-meta-label' }, '上次签到'),
              h(
                'div',
                { class: 'kg-vip-meta-value' },
                lastResult.value?.at ? formatDateTime(lastResult.value.at) : '—',
              ),
            ]),
          ]),
          h('div', { class: 'kg-vip-switch-row' }, [
            h('div', {}, [
              h('div', { class: 'kg-vip-switch-title' }, '打开播放器后自动签到'),
              h(
                'div',
                { class: 'kg-vip-switch-sub' },
                '每天最多自动执行一次，今日已领取时跳过',
              ),
            ]),
            renderSwitch(autoCheckin.value, toggleAuto),
          ]),
        ]);
    },
  });

  ctx.ui.settings.define({
    id: 'default',
    title: '酷狗概念版自动签到',
    description: '打开播放器后自动领取当天 VIP，并显示到期时间',
    component: SettingsPanel,
  });
}

export function activate(ctx) {
  console.log(`${PLUGIN_TAG} 已激活 v${ctx.manifest?.version || ''}`);
  const runtime = createRuntime();
  currentRuntime = runtime;
  ctx.dispose(() => {
    runtime.dispose();
    if (currentRuntime === runtime) currentRuntime = null;
  });
  installStyles(ctx);
  installSettings(ctx);
  void bootstrap(ctx, runtime);
}

export function deactivate() {
  console.log(`${PLUGIN_TAG} 已停用`);
}
