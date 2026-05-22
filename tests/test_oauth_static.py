from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def test_oauth_settings_exposes_codex_model_slots():
    config_html = (PROJECT_ROOT / "plugins/_oauth/webui/config.html").read_text(encoding="utf-8")
    store_js = (PROJECT_ROOT / "plugins/_oauth/webui/oauth-config-store.js").read_text(encoding="utf-8")

    assert "Agent Zero models" in config_html
    assert "Main model" in store_js
    assert "Utility model" in store_js
    assert "Use Codex" in config_html
    assert "Search available Codex models" in config_html
    assert "copyMainToUtility" in config_html + store_js


def test_oauth_settings_remove_redundant_model_action_and_account_label():
    config_html = (PROJECT_ROOT / "plugins/_oauth/webui/config.html").read_text(encoding="utf-8")
    store_js = (PROJECT_ROOT / "plugins/_oauth/webui/oauth-config-store.js").read_text(encoding="utf-8")

    assert "Check Models" not in config_html
    assert "Codex/ChatGPT Account" not in config_html + store_js


def test_oauth_available_models_list_sits_above_advanced_without_borders():
    config_html = (PROJECT_ROOT / "plugins/_oauth/webui/config.html").read_text(encoding="utf-8")

    assert "Available models from Codex account" in config_html
    assert config_html.index("Available models") < config_html.index("<summary>Advanced</summary>")
    assert ".oauth-models-panel {\n      display: grid;\n      gap: 10px;\n      padding: 0;\n      border: 0;\n    }" in config_html
    model_chip_rule = config_html.split(".oauth-models span {", 1)[1].split("}", 1)[0]
    assert "border:" not in model_chip_rule


def test_oauth_model_slots_reuse_model_config_api():
    store_js = (PROJECT_ROOT / "plugins/_oauth/webui/oauth-config-store.js").read_text(encoding="utf-8")

    assert 'import { store as modelConfigStore } from "/plugins/_model_config/webui/model-config-store.js";' in store_js
    assert 'const MODEL_CONFIG_API = "/plugins/_model_config";' in store_js
    assert "model_config_get" in store_js
    assert "model_config_set" in store_js
    assert 'const CODEX_PROVIDER = "codex_oauth";' in store_js
    assert "saveModelConfigIfDirty" in store_js


def test_oauth_model_wrappers_do_not_add_box_borders_or_lateral_padding():
    config_html = (PROJECT_ROOT / "plugins/_oauth/webui/config.html").read_text(encoding="utf-8")

    assert ".oauth-model-config {\n      display: grid;\n      gap: 12px;\n      padding: 0;\n      border: 0;\n    }" in config_html
    assert ".oauth-model-card {\n      display: grid;" in config_html
    assert "      padding: 0;\n      border: 0;\n      background: transparent;" in config_html
    assert "oauth-model-card.is-codex" not in config_html
    assert "'is-codex'" not in config_html


def test_connected_codex_welcome_card_renders_usage_limit_bars():
    discovery_cards = (
        PROJECT_ROOT
        / "plugins/_discovery/extensions/python/banners/10_discovery_cards.py"
    ).read_text(encoding="utf-8")
    welcome_cards = (
        PROJECT_ROOT
        / "plugins/_discovery/extensions/webui/welcome-actions-end/discovery-cards.html"
    ).read_text(encoding="utf-8")
    discovery_store = (PROJECT_ROOT / "plugins/_discovery/webui/discovery-store.js").read_text(encoding="utf-8")

    assert "ChatGPT/Codex Connected" in discovery_cards
    assert "5h and weekly limits are ready." not in discovery_cards
    assert "usage_windows" in discovery_cards
    assert "discovery-usage" in welcome_cards
    assert "discovery-usage-bar" in welcome_cards
    assert "formatRemainingPercent(window)" in welcome_cards + discovery_store
