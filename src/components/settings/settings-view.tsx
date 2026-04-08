import { useWikiStore } from "@/stores/wiki-store"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useState, useEffect } from "react"
import { useTranslation } from "react-i18next"
import i18n from "@/i18n"
import { saveLanguage } from "@/lib/project-store"

const PROVIDERS = [
  { value: "openai" as const, label: "OpenAI", models: ["gpt-4o", "gpt-4.1", "gpt-4o-mini"] },
  { value: "anthropic" as const, label: "Anthropic", models: ["claude-sonnet-4-5-20250514", "claude-opus-4-5-20250514", "claude-haiku-4-5-20251001"] },
  { value: "google" as const, label: "Google", models: ["gemini-2.5-pro", "gemini-2.5-flash"] },
  { value: "ollama" as const, label: "Ollama (Local)", models: [] },
  { value: "custom" as const, label: "Custom", models: [] },
]

const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "zh", label: "中文" },
]

export function SettingsView() {
  const { t } = useTranslation()
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const setLlmConfig = useWikiStore((s) => s.setLlmConfig)
  const searchApiConfig = useWikiStore((s) => s.searchApiConfig)
  const setSearchApiConfig = useWikiStore((s) => s.setSearchApiConfig)

  const [provider, setProvider] = useState(llmConfig.provider)
  const [apiKey, setApiKey] = useState(llmConfig.apiKey)
  const [model, setModel] = useState(llmConfig.model)
  const [ollamaUrl, setOllamaUrl] = useState(llmConfig.ollamaUrl)
  const [customEndpoint, setCustomEndpoint] = useState(llmConfig.customEndpoint)
  const [maxContextSize, setMaxContextSize] = useState(llmConfig.maxContextSize ?? 204800)
  const [searchProvider, setSearchProvider] = useState(searchApiConfig.provider)
  const [searchApiKey, setSearchApiKey] = useState(searchApiConfig.apiKey)
  const [saved, setSaved] = useState(false)
  const [currentLang, setCurrentLang] = useState(i18n.language)

  useEffect(() => {
    setProvider(llmConfig.provider)
    setApiKey(llmConfig.apiKey)
    setModel(llmConfig.model)
    setOllamaUrl(llmConfig.ollamaUrl)
    setCustomEndpoint(llmConfig.customEndpoint)
  }, [llmConfig])

  useEffect(() => {
    setSearchProvider(searchApiConfig.provider)
    setSearchApiKey(searchApiConfig.apiKey)
  }, [searchApiConfig])

  const currentProvider = PROVIDERS.find((p) => p.value === provider)

  async function handleSave() {
    const { saveLlmConfig, saveSearchApiConfig } = await import("@/lib/project-store")
    const newConfig = { provider, apiKey, model, ollamaUrl, customEndpoint, maxContextSize }
    const newSearchConfig = { provider: searchProvider, apiKey: searchApiKey }
    setSearchApiConfig(newSearchConfig)
    await saveSearchApiConfig(newSearchConfig)
    setLlmConfig(newConfig)
    await saveLlmConfig(newConfig)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  async function handleLanguageChange(lang: string) {
    await i18n.changeLanguage(lang)
    setCurrentLang(lang)
    await saveLanguage(lang)
  }

  return (
    <div className="h-full overflow-auto p-8">
      <div className="mx-auto max-w-xl">
        <h2 className="mb-6 text-2xl font-bold">{t("settings.title")}</h2>

        <div className="space-y-6">
          {/* Language section */}
          <div className="space-y-4 rounded-lg border p-4">
            <h3 className="font-semibold">{t("settings.language")}</h3>
            <div className="flex flex-wrap gap-2">
              {LANGUAGES.map((lang) => (
                <button
                  key={lang.value}
                  onClick={() => handleLanguageChange(lang.value)}
                  className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                    currentLang === lang.value
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border hover:bg-accent"
                  }`}
                >
                  {lang.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{t("settings.languageHint")}</p>
          </div>

          {/* LLM Provider section */}
          <div className="space-y-4 rounded-lg border p-4">
            <h3 className="font-semibold">{t("settings.llmProvider")}</h3>

            <div className="space-y-2">
              <Label>{t("settings.provider")}</Label>
              <div className="flex flex-wrap gap-2">
                {PROVIDERS.map((p) => (
                  <button
                    key={p.value}
                    onClick={() => {
                      setProvider(p.value)
                      setModel(p.models[0] || "")
                    }}
                    className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                      provider === p.value
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border hover:bg-accent"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {provider === "custom" && (
              <div className="space-y-2">
                <Label htmlFor="customEndpoint">{t("settings.customEndpoint")}</Label>
                <Input
                  id="customEndpoint"
                  value={customEndpoint}
                  onChange={(e) => setCustomEndpoint(e.target.value)}
                  placeholder="https://your-api.example.com/v1"
                />
                <p className="text-xs text-muted-foreground">
                  {t("settings.customEndpointHint")}
                </p>
              </div>
            )}

            {provider === "ollama" && (
              <div className="space-y-2">
                <Label htmlFor="ollamaUrl">{t("settings.ollamaUrl")}</Label>
                <Input
                  id="ollamaUrl"
                  value={ollamaUrl}
                  onChange={(e) => setOllamaUrl(e.target.value)}
                  placeholder="http://localhost:11434"
                />
              </div>
            )}

            {provider !== "ollama" && (
              <div className="space-y-2">
                <Label htmlFor="apiKey">{t("settings.apiKey")}</Label>
                <Input
                  id="apiKey"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={
                    provider === "custom"
                      ? t("settings.customApiKey")
                      : t("settings.apiKeyPlaceholder", { provider: currentProvider?.label })
                  }
                />
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="model">{t("settings.model")}</Label>
              {currentProvider && currentProvider.models.length > 0 ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-2">
                    {currentProvider.models.map((m) => (
                      <button
                        key={m}
                        onClick={() => setModel(m)}
                        className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                          model === m
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border hover:bg-accent"
                        }`}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                  <Input
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder={t("settings.customModel")}
                  />
                </div>
              ) : (
                <Input
                  id="model"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={t("settings.modelPlaceholder")}
                />
              )}
            </div>
          </div>

          {/* Context Window Size */}
          <div className="space-y-4 rounded-lg border p-4">
            <h3 className="font-semibold">Context Window</h3>
            <p className="text-xs text-muted-foreground">
              Maximum context size sent to the LLM. Larger context allows more wiki pages in each query but costs more tokens.
            </p>

            <div className="space-y-3">
              <ContextSizeSelector value={maxContextSize} onChange={setMaxContextSize} />
            </div>
          </div>

          {/* Web Search API section */}
          <div className="space-y-4 rounded-lg border p-4">
            <h3 className="font-semibold">Web Search (Deep Research)</h3>
            <p className="text-xs text-muted-foreground">
              Enable AI-powered web research to automatically find relevant sources for knowledge gaps.
            </p>

            <div className="space-y-2">
              <Label>Search Provider</Label>
              <div className="flex flex-wrap gap-2">
                {[
                  { value: "none" as const, label: "Disabled" },
                  { value: "tavily" as const, label: "Tavily" },
                ].map((p) => (
                  <button
                    key={p.value}
                    onClick={() => setSearchProvider(p.value)}
                    className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                      searchProvider === p.value
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border hover:bg-accent"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {searchProvider !== "none" && (
              <div className="space-y-2">
                <Label htmlFor="searchApiKey">API Key</Label>
                <Input
                  id="searchApiKey"
                  type="password"
                  value={searchApiKey}
                  onChange={(e) => setSearchApiKey(e.target.value)}
                  placeholder="Enter your Tavily API key (tavily.com)"
                />
              </div>
            )}
          </div>

          <Button onClick={handleSave} className="w-full">
            {saved ? t("settings.saved") : t("settings.save")}
          </Button>
        </div>
      </div>
    </div>
  )
}

// Context size presets matching common model context windows
const CONTEXT_PRESETS = [
  { value: 4096, label: "4K" },
  { value: 8192, label: "8K" },
  { value: 16384, label: "16K" },
  { value: 32768, label: "32K" },
  { value: 65536, label: "64K" },
  { value: 131072, label: "128K" },
  { value: 204800, label: "200K" },
  { value: 262144, label: "256K" },
  { value: 524288, label: "512K" },
  { value: 1000000, label: "1M" },
]

function ContextSizeSelector({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  // Find closest preset index
  const closestIndex = CONTEXT_PRESETS.reduce((best, preset, i) => {
    return Math.abs(preset.value - value) < Math.abs(CONTEXT_PRESETS[best].value - value) ? i : best
  }, 0)

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium">{formatSize(value)}</span>
        <span className="text-xs text-muted-foreground">
          ~{Math.floor(value * 0.6 / 1000)}K chars for wiki content
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={CONTEXT_PRESETS.length - 1}
        step={1}
        value={closestIndex}
        onChange={(e) => onChange(CONTEXT_PRESETS[parseInt(e.target.value)].value)}
        className="w-full h-2 rounded-lg appearance-none cursor-pointer accent-primary"
        style={{ background: `linear-gradient(to right, #4f46e5 ${(closestIndex / (CONTEXT_PRESETS.length - 1)) * 100}%, #e5e7eb ${(closestIndex / (CONTEXT_PRESETS.length - 1)) * 100}%)` }}
      />
      <div className="flex justify-between mt-1">
        {CONTEXT_PRESETS.map((preset, i) => (
          <button
            key={preset.value}
            type="button"
            onClick={() => onChange(preset.value)}
            className={`text-[9px] px-0.5 ${
              i === closestIndex ? "text-primary font-bold" : "text-muted-foreground/50"
            }`}
          >
            {preset.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function formatSize(chars: number): string {
  if (chars >= 1000000) return `${(chars / 1000000).toFixed(1)}M characters`
  if (chars >= 1000) return `${Math.round(chars / 1000)}K characters`
  return `${chars} characters`
}
