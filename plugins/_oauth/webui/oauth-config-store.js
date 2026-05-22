import { createStore } from "/js/AlpineStore.js";
import { callJsonApi, fetchApi } from "/js/api.js";
import { store as modelConfigStore } from "/plugins/_model_config/webui/model-config-store.js";
import {
  toastFrontendError,
  toastFrontendInfo,
  toastFrontendSuccess,
} from "/components/notifications/notification-store.js";

const MODEL_CONFIG_API = "/plugins/_model_config";
const STATUS_API = "/plugins/_oauth/status";
const START_DEVICE_LOGIN_API = "/plugins/_oauth/start_device_login";
const POLL_DEVICE_LOGIN_API = "/plugins/_oauth/poll_device_login";
const MODELS_API = "/plugins/_oauth/models";
const DISCONNECT_API = "/plugins/_oauth/disconnect";
const MAX_POLL_MS = 120000;
const CODEX_PROVIDER = "codex_oauth";
const MODEL_SLOTS = [
  {
    key: "chat_model",
    title: "Main model",
    description: "Primary model for chat, reasoning, and browser tasks.",
    icon: "forum",
  },
  {
    key: "utility_model",
    title: "Utility model",
    description: "Background model for summaries, memory, and prompt preparation.",
    icon: "manufacturing",
  },
];

function ensureConfig(config) {
  if (!config || typeof config !== "object") return null;
  config.codex = config.codex && typeof config.codex === "object" ? config.codex : {};
  const codex = config.codex;
  codex.enabled = codex.enabled !== false;
  codex.auth_file_path = String(codex.auth_file_path || "");
  codex.issuer = String(codex.issuer || "https://auth.openai.com");
  codex.token_url = String(codex.token_url || "https://auth.openai.com/oauth/token");
  codex.client_id = String(codex.client_id || "app_EMoamEEZ73f0CkXaXp7hrann");
  codex.upstream_base_url = String(codex.upstream_base_url || "https://chatgpt.com/backend-api/codex");
  codex.proxy_base_path = String(codex.proxy_base_path || "/oauth/codex");
  codex.callback_path = String(codex.callback_path || "/auth/callback");
  codex.require_proxy_token = Boolean(codex.require_proxy_token);
  codex.proxy_token = String(codex.proxy_token || "");
  codex.codex_version = String(codex.codex_version || "");
  codex.models = Array.isArray(codex.models) ? codex.models : [];
  return config;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function ensureModelSlot(config, key) {
  if (!config[key] || typeof config[key] !== "object") config[key] = {};
  config[key] = {
    provider: "",
    name: "",
    api_base: "",
    ctx_length: key === "utility_model" ? 128000 : 200000,
    ctx_history: key === "chat_model" ? 0.7 : undefined,
    ctx_input: key === "utility_model" ? 0.7 : undefined,
    vision: key === "chat_model" ? true : undefined,
    max_embeds: key === "chat_model" ? 10 : undefined,
    rl_requests: 0,
    rl_input: 0,
    rl_output: 0,
    kwargs: {},
    ...config[key],
  };
  if (!config[key].kwargs || typeof config[key].kwargs !== "object") config[key].kwargs = {};
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

export const store = createStore("oauthConfig", {
  config: null,
  status: null,
  loadingStatus: false,
  connecting: false,
  disconnecting: false,
  loadingModels: false,
  models: [],
  modelSlots: MODEL_SLOTS,
  modelConfig: null,
  modelConfigLoading: false,
  modelConfigSaving: false,
  modelConfigDirty: false,
  modelSlotDirty: {
    chat_model: false,
    utility_model: false,
  },
  modelDropdown: {
    chat_model: { open: false },
    utility_model: { open: false },
  },
  device: null,
  pollTimer: null,
  pollStartedAt: 0,

  async init(config, context = null) {
    this.bindConfig(config);
    this.installSettingsHooks(context);
    await Promise.all([this.loadStatus(), this.loadModelConfig()]);
  },

  cleanup() {
    this.stopPolling();
    this.config = null;
    this.status = null;
    this.models = [];
    this.modelConfig = null;
    this.modelConfigLoading = false;
    this.modelConfigSaving = false;
    this.modelConfigDirty = false;
    this.modelSlotDirty = { chat_model: false, utility_model: false };
    this.modelDropdown = {
      chat_model: { open: false },
      utility_model: { open: false },
    };
    this.device = null;
  },

  bindConfig(config) {
    const safeConfig = ensureConfig(config);
    if (!safeConfig) return;
    if (this.config === safeConfig) return;
    this.config = safeConfig;
  },

  codex() {
    return this.config?.codex || {};
  },

  connected() {
    return Boolean(this.status?.codex?.connected);
  },

  statusLabel() {
    if (this.loadingStatus) return "Checking";
    return this.connected() ? "Connected" : "Not connected";
  },

  usage() {
    return this.status?.codex?.usage || null;
  },

  usageWindows() {
    const usage = this.usage();
    if (!usage?.available) return [];
    return [
      { key: "primary", title: "Session", ...(usage.primary || {}) },
      { key: "secondary", title: "Week", ...(usage.secondary || {}) },
    ].filter((window) => Number.isFinite(this.remainingPercent(window)));
  },

  usageWidth(window) {
    const value = Math.max(0, Math.min(100, this.remainingPercent(window)));
    return `${value}%`;
  },

  remainingPercent(window) {
    const remaining = Number(window?.remaining_percent);
    if (Number.isFinite(remaining)) return remaining;
    const used = Number(window?.used_percent);
    if (Number.isFinite(used)) return 100 - used;
    return Number.NaN;
  },

  formatRemainingPercent(window) {
    const number = this.remainingPercent(window);
    if (!Number.isFinite(number)) return "0%";
    return `${Math.round(number * 10) / 10}% left`;
  },

  formatWindowLabel(window) {
    return window?.label || "";
  },

  formatReset(window) {
    const seconds = Number(window?.reset_at || 0);
    if (!Number.isFinite(seconds) || seconds <= 0) return "";
    const remainingMs = Math.max(0, seconds * 1000 - Date.now());
    const minutes = Math.round(remainingMs / 60000);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours}h`;
    return `${Math.round(hours / 24)}d`;
  },

  endpointUrl() {
    const base = this.codex().proxy_base_path || "/oauth/codex";
    return `${window.location.origin}${base}/v1`;
  },

  callbackUrl() {
    const path = this.codex().callback_path || "/auth/callback";
    return `${window.location.origin}${path}`;
  },

  installSettingsHooks(context) {
    if (!context || context.__oauthConfigHooksInstalled) return;

    const originalSave = context.save.bind(context);
    context.save = async () => {
      context.error = null;
      try {
        await this.saveModelConfigIfDirty();
      } catch (error) {
        context.error = messageOf(error) || "Failed to save model selection.";
        return;
      }
      await originalSave();
    };

    context.__oauthConfigHooksInstalled = true;
  },

  async loadModelConfig() {
    if (this.modelConfigLoading) return;
    this.modelConfigLoading = true;
    try {
      await modelConfigStore.ensureLoaded();
      const response = await fetchApi(`${MODEL_CONFIG_API}/model_config_get`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await response.json().catch(() => ({}));
      const modelConfig = data.config && typeof data.config === "object" ? data.config : {};
      ensureModelSlot(modelConfig, "chat_model");
      ensureModelSlot(modelConfig, "utility_model");
      this.modelConfig = modelConfig;
      this.modelConfigDirty = false;
      this.modelSlotDirty = { chat_model: false, utility_model: false };
    } catch (error) {
      this.modelConfig = null;
      void toastFrontendError(messageOf(error), "OAuth Connections");
    } finally {
      this.modelConfigLoading = false;
    }
  },

  modelSlot(key) {
    if (!this.modelConfig) return {};
    ensureModelSlot(this.modelConfig, key);
    return this.modelConfig[key];
  },

  slotUsesCodex(key) {
    return this.modelSlot(key).provider === CODEX_PROVIDER;
  },

  providerName(provider) {
    if (!provider) return "Not configured";
    const found = (modelConfigStore.chatProviders || []).find((item) => item.value === provider);
    return found?.label || provider;
  },

  slotStatusLabel(key) {
    const slot = this.modelSlot(key);
    if (slot.provider === CODEX_PROVIDER) return "";
    return `Currently ${this.providerName(slot.provider)}`;
  },

  markModelDirty(key) {
    this.modelConfigDirty = true;
    this.modelSlotDirty = { ...this.modelSlotDirty, [key]: true };
  },

  useCodexForSlot(key) {
    const slot = this.modelSlot(key);
    const previousProvider = slot.provider;
    slot.provider = CODEX_PROVIDER;
    slot.api_base = "";
    if (previousProvider && previousProvider !== CODEX_PROVIDER) {
      slot.name = "";
    }
    if (!slot.kwargs || typeof slot.kwargs !== "object") slot.kwargs = {};
    this.markModelDirty(key);
    if (this.models.length) {
      this.openModelDropdown(key);
    } else {
      void this.loadModels({ openDropdown: key, silent: true });
    }
  },

  copyMainToUtility() {
    if (!this.modelConfig) return;
    const main = this.modelSlot("chat_model");
    const utility = this.modelSlot("utility_model");
    utility.provider = CODEX_PROVIDER;
    utility.name = main.name || "";
    utility.api_base = main.api_base || "";
    utility.kwargs = clone(main.kwargs || {});
    this.markModelDirty("utility_model");
  },

  openModelDropdown(key) {
    if (!this.slotUsesCodex(key)) return;
    this.modelDropdown[key] = { ...this.modelDropdown[key], open: true };
    if (!this.models.length && !this.loadingModels) {
      void this.loadModels({ openDropdown: key, silent: true });
    }
  },

  closeModelDropdown(key) {
    this.modelDropdown[key] = { ...this.modelDropdown[key], open: false };
  },

  filteredModels(key) {
    const query = String(this.modelSlot(key).name || "").trim().toLowerCase();
    const models = this.models || [];
    const filtered = query
      ? models.filter((model) => String(model).toLowerCase().includes(query))
      : models;
    return filtered.slice(0, 80);
  },

  selectModel(key, model) {
    const slot = this.modelSlot(key);
    slot.provider = CODEX_PROVIDER;
    slot.name = model;
    this.markModelDirty(key);
    this.closeModelDropdown(key);
  },

  validateModelConfig() {
    if (!this.modelConfigDirty) return;
    for (const slot of MODEL_SLOTS) {
      if (!this.modelSlotDirty[slot.key]) continue;
      const model = this.modelSlot(slot.key);
      if (model.provider === CODEX_PROVIDER && !String(model.name || "").trim()) {
        throw new Error(`Choose a ${slot.title} before saving.`);
      }
    }
  },

  async saveModelConfigIfDirty() {
    if (!this.modelConfigDirty || !this.modelConfig) return;
    this.validateModelConfig();
    this.modelConfigSaving = true;
    try {
      const response = await fetchApi(`${MODEL_CONFIG_API}/model_config_set`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_name: "",
          agent_profile: "",
          config: this.modelConfig,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!data?.ok) throw new Error(data?.error || "Could not save model selection.");
      this.modelConfigDirty = false;
      this.modelSlotDirty = { chat_model: false, utility_model: false };
      await modelConfigStore.refreshModelsSummary?.();
    } finally {
      this.modelConfigSaving = false;
    }
  },

  async loadStatus() {
    if (this.loadingStatus) return;
    this.loadingStatus = true;
    try {
      const response = await callJsonApi(STATUS_API, {});
      this.status = response;
    } catch (error) {
      void toastFrontendError(messageOf(error), "OAuth Connections");
    } finally {
      this.loadingStatus = false;
    }
  },

  async connectCodex() {
    if (this.connecting) return;
    this.connecting = true;
    try {
      const response = await callJsonApi(START_DEVICE_LOGIN_API, {});
      if (!response?.ok || !response.verification_url || !response.attempt_id) {
        throw new Error(response?.error || "Could not start Codex sign-in.");
      }
      this.device = response;
      window.open(response.verification_url, "_blank", "noopener,noreferrer");
      void toastFrontendInfo("Enter the code shown here in the opened browser tab.", "OAuth Connections");
      this.startPolling();
    } catch (error) {
      this.connecting = false;
      void toastFrontendError(messageOf(error), "OAuth Connections");
    }
  },

  startPolling() {
    this.stopPolling();
    this.pollStartedAt = Date.now();
    const tick = async () => {
      if (!this.device?.attempt_id) return;
      try {
        const response = await callJsonApi(POLL_DEVICE_LOGIN_API, {
          attempt_id: this.device.attempt_id,
        });
        if (!response?.ok) {
          if (response?.expired) {
            this.connecting = false;
            this.device = null;
            this.stopPolling();
          }
          throw new Error(response?.error || "Could not finish Codex sign-in.");
        }
        if (response.completed) {
          await this.loadStatus();
          this.device = null;
          this.connecting = false;
          this.stopPolling();
          void toastFrontendSuccess("Codex account connected.", "OAuth Connections");
          return;
        }
      } catch (error) {
        this.connecting = false;
        this.stopPolling();
        void toastFrontendError(messageOf(error), "OAuth Connections");
        return;
      }
      if (Date.now() - this.pollStartedAt > MAX_POLL_MS) {
        this.connecting = false;
        this.device = null;
        this.stopPolling();
        return;
      }
    };
    void tick();
    const delay = Math.max(1500, Number(this.device.interval || 5) * 1000);
    this.pollTimer = window.setInterval(tick, delay);
  },

  stopPolling() {
    if (this.pollTimer) window.clearInterval(this.pollTimer);
    this.pollTimer = null;
  },

  async loadModels({ openDropdown = "", silent = false } = {}) {
    if (this.loadingModels) return;
    this.loadingModels = true;
    try {
      const response = await callJsonApi(MODELS_API, {});
      if (!response?.ok) throw new Error(response?.error || "Could not load Codex models.");
      this.models = Array.isArray(response.models) ? response.models : [];
      if (openDropdown) this.openModelDropdown(openDropdown);
      if (!silent) void toastFrontendSuccess("Codex models loaded.", "OAuth Connections");
    } catch (error) {
      this.models = [];
      if (!silent) void toastFrontendError(messageOf(error), "OAuth Connections");
    } finally {
      this.loadingModels = false;
    }
  },

  async disconnectCodex() {
    if (this.disconnecting || !this.connected()) return;
    const confirmed = window.confirm("Disconnect this OpenAI account and remove stored OAuth tokens?");
    if (!confirmed) return;

    this.disconnecting = true;
    try {
      const response = await callJsonApi(DISCONNECT_API, {});
      if (!response?.ok) throw new Error(response?.error || "Could not disconnect the account.");
      this.status = response.codex ? { ok: true, codex: response.codex } : this.status;
      this.models = [];
      this.device = null;
      this.connecting = false;
      this.stopPolling();
      void toastFrontendSuccess("OpenAI account disconnected.", "OAuth Connections");
      await this.loadStatus();
    } catch (error) {
      void toastFrontendError(messageOf(error), "OAuth Connections");
    } finally {
      this.disconnecting = false;
    }
  },

  cancelConnect() {
    this.connecting = false;
    this.device = null;
    this.stopPolling();
  },
});
