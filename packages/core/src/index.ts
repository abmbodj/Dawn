export type { ModelMessage } from "ai"
export { type AgentOptions, DawnAgent } from "./agent/agent"
export {
  type ClassifiedFailure,
  classifyFailure,
  type FailureKind,
  isRetryableToolFailure,
} from "./agent/errors"
export { estimateMemoryTokens, loadProjectMemory, type ProjectMemory } from "./agent/project-memory"
export { buildSystemPrompt } from "./agent/system"
export { listAuthProviders, removeApiKey, resolveApiKey, setApiKey } from "./auth/auth"
export {
  type CredentialSource,
  type DiscoveredCredential,
  discoverCredentials,
  envToProvider,
  maskKey,
  parseCodexAuth,
  parseEnvAssignments,
  parseOpencodeAuth,
  persistDiscovered,
} from "./auth/discover"
export {
  BUILT_IN_GITHUB_CLIENT_ID,
  type DeviceFlowStart,
  GITHUB_CLIENT_ID_ENV,
  pollForToken,
  resolveGithubClientId,
  startDeviceFlow,
  tryGhCliToken,
} from "./auth/github-oauth"
export { type AgentEvent, type AgentEventHandler, Bus, type StepUsage, type TodoItem } from "./bus/bus"
export {
  type CustomProvider,
  type DawnConfig,
  DawnConfigSchema,
  hasConfiguredModel,
  loadConfig,
  saveConfig,
} from "./config/config"
export {
  buildRequestMessages,
  contextBudget,
  DEFAULT_CONTEXT_MODE,
  DEFAULT_TOKEN_BUDGET,
  estimateTokens,
  maxReadLines,
  ttlForKind,
} from "./context/budget"
export { buildRepoIndex, guessLanguage, type IndexResult, indexFile, isIgnoredPath } from "./context/indexer"
export { ContextStore } from "./context/store"
export { getFileSummary, summarizeEntry } from "./context/summarize"
export type {
  BuiltRequest,
  ContextBudget,
  ContextMode,
  ContextPlan,
  ContextPlanItem,
  ContextPlanItemKind,
  ContextPlanTotals,
  ContextStats,
  FileSummary,
  RecordedContextPlan,
  RepoIndexEntry,
  RepoIndexStatus,
  WorkingSetItem,
  WorkingSetKind,
} from "./context/types"
export { ContextWorkingSet } from "./context/working-set"
export {
  classifyDoctorOutcome,
  DOCTOR_PROMPT,
  type DoctorMode,
  type DoctorResult,
  type DoctorSignals,
  evaluateModel,
  runModelDoctor,
  selectDoctorTargets,
} from "./doctor/models"
export { connectMcpServers, type McpConnection, type McpToolInfo } from "./mcp/client"
export { loadMcpServers, type McpServerConfig, McpServerSchema } from "./mcp/config"
export { cacheDir, configDir, dataDir } from "./paths"
export { Asker, type AskHandler, type AskOption, type UserQuestion } from "./permission/asker"
export {
  type PermissionDecision,
  PermissionGate,
  type PermissionHandler,
  type PermissionMode,
  type PermissionRequest,
} from "./permission/permission"
export { copyToClipboard } from "./platform/clipboard"
export { type ExternalOpenCommand, externalOpenCommand, openExternalUrl } from "./platform/open-external"
export { type PluginCommand, renderCommandPrompt } from "./plugins/commands"
export {
  addPlugin,
  type InstalledPlugin,
  listInstalledPlugins,
  loadEnabledPlugins,
  pluginsDir,
  removePlugin,
} from "./plugins/registry"
export {
  BLESSED_MODELS,
  type Catalog,
  FALLBACK_CATALOG,
  FLOOR_CONTEXT_TOKENS,
  getModelInfo,
  loadCatalog,
  type ModelCost,
  type ModelInfo,
  type ModelTier,
  meetsFloor,
  modelTier,
  normalizeModelRef,
  type ProviderInfo,
  parseModelRef,
} from "./provider/catalog"
export { withAllLiveModels, withLiveModels } from "./provider/live-models"
export { detectLMStudio, lmStudioBaseURL, withLMStudio } from "./provider/lmstudio"
export {
  type FitStatus,
  formatBytes,
  type LocalModelFit,
  localModelFit,
} from "./provider/local-fit"
export {
  isUsableModelRef,
  type ModelSelection,
  type ModelSelectionReason,
  type SelectInitialModelOptions,
  selectInitialModel,
  selectProviderInitialModel,
} from "./provider/model-selection"
export { detectOllama, ollamaBaseURL, withOllama } from "./provider/ollama"
export {
  isOllamaReachable,
  type LocalModelRec,
  type PullProgress,
  parsePullProgress,
  pullOllamaModel,
  RECOMMENDED_LOCAL_MODELS,
  recommendLocalModel,
} from "./provider/ollama-pull"
export {
  detectFamily,
  type ModelFamily,
  type ModelProfile,
  type ReasoningHandling,
  resolveProfile,
} from "./provider/profile"
export {
  connectedProviders,
  ENTERPRISE_PROVIDERS,
  enterpriseConfigured,
  type ProviderStatus,
  type ResolvedModel,
  resolveModel,
} from "./provider/provider"
export { type ModelRole, resolveRoleModel } from "./provider/roles"
export { resetDawnData } from "./reset"
export { type SessionMeta, SessionStore } from "./session/store"
export { type LoadedSkill, SkillBuffer } from "./skills/buffer"
export { type ParsedFrontmatter, parseFrontmatter } from "./skills/frontmatter"
export {
  buildSkillCatalog,
  discoverSkills,
  findSkill,
  matchAutoTriggers,
} from "./skills/registry"
export type { Skill, SkillCatalogEntry, SkillFrontmatter } from "./skills/types"
export { applyEdit } from "./tools/edit"
export {
  buildRepoOverview,
  createTools,
  type RepoOverviewOptions,
  type ToolContext,
  toolPreview,
  toolTitle,
} from "./tools/index"
export { capLine, truncateMiddle } from "./tools/truncate"
export { computeCost, toStepUsage, UsageLedger, type UsageTotals } from "./usage/ledger"
