export interface SkillFrontmatter {
  name: string
  description: string
  allowedTools?: string[]
}

export interface Skill {
  name: string
  description: string
  body: string
  dir: string
  source: "project" | "personal" | "plugin" | "claude"
  pluginName?: string
  allowedTools?: string[]
  estimatedBodyTokens: number
}

export interface SkillCatalogEntry {
  name: string
  description: string
  source: Skill["source"]
}
