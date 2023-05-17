import { v4 as uuidv4 } from "uuid"
import { EventType, type ModelProviderOptions } from "window.ai"

import { Storage } from "@plasmohq/storage"

import { PortName } from "~core/constants"
import { Extension } from "~core/extension"
import { local, modelAPICallers, openrouter } from "~core/llm"
import { getExternalConfigURL } from "~core/utils/utils"
import { ModelID, isKnownModel } from "~public-interface"

import { BaseManager } from "./base"

export enum AuthType {
  // Let another site handle all authentication
  External = "external",
  // Use an API key
  APIKey = "key"
}

const APIKeyURL: Record<ModelID, string> = {
  [ModelID.GPT3]: "https://platform.openai.com/account/api-keys",
  [ModelID.GPT4]: "https://platform.openai.com/account/api-keys",
  [ModelID.Together]: "https://api.together.xyz/",
  [ModelID.Cohere]: "https://dashboard.cohere.ai/api-keys"
}

const defaultAPILabel: Record<ModelID, string> = {
  [ModelID.GPT3]: "OpenAI: GPT-3.5",
  [ModelID.GPT4]: "OpenAI: GPT-4",
  [ModelID.Together]: "Together: GPT NeoXT 20B",
  [ModelID.Cohere]: "Cohere: Xlarge"
}

const authIndexName = "byAuth"

// TODO add `params` with model-specific params
export interface Config {
  id: string
  auth: AuthType
  label: string
  models: ModelID[]

  session?: ModelProviderOptions["session"]
  baseUrl?: string
  apiKey?: string
}

class ConfigManager extends BaseManager<Config> {
  protected defaultConfig: Storage
  protected modelHandlers: Storage

  constructor() {
    super("configs", "sync")

    // Just store the id of the default config
    this.defaultConfig = new Storage({
      area: "sync"
    })
    this.defaultConfig.setNamespace(`configs-default-`)

    // For each ModelID, store the id of the config that handles it
    this.modelHandlers = new Storage({
      area: "sync"
    })
    this.modelHandlers.setNamespace(`configs-model-handlers-`)
  }

  init(auth: AuthType, modelId?: ModelID): Config {
    const id = uuidv4()
    const caller = this.getCallerForAuth(auth, modelId)
    const label = this.getLabelForAuth(auth, modelId)
    switch (auth) {
      case AuthType.External:
        return {
          id,
          auth,
          label,
          models: [ModelID.GPT3, ModelID.GPT4]
        }
      case AuthType.APIKey:
        return {
          id,
          auth,
          models: modelId ? [modelId] : [],
          label
        }
    }
  }

  async save(config: Config): Promise<boolean> {
    const isNew = await super.save(config)

    if (isNew) {
      // Index by auth type
      await this.indexBy(config, config.auth, authIndexName)
    }

    return isNew
  }

  async getOrInit(authType: AuthType, modelId?: ModelID): Promise<Config> {
    return (
      (await this.forAuthAndModel(authType, modelId)) ||
      this.init(authType, modelId)
    )
  }

  async forModel(modelId: ModelID): Promise<Config> {
    const configId = await this.modelHandlers.get(modelId)
    if (configId) {
      const config = await this.get(configId)
      if (config) {
        const defaults = this.init(config.auth, modelId)
        return {
          ...defaults,
          ...config
        }
      }
      await this.modelHandlers.remove(modelId)
    }
    return this.getOrInit(AuthType.APIKey, modelId)
  }

  isCredentialed(config: Config): boolean {
    switch (config.auth) {
      case AuthType.External:
        return !!config.session
      case AuthType.APIKey:
        return config.models.length ? !!config.apiKey : true
    }
  }

  async setDefault(config: Config) {
    await this.save(config)
    for (const modelId of config.models) {
      await this.modelHandlers.set(modelId, config.id)
    }
    const previous = await this.defaultConfig.get("id")
    await this.defaultConfig.set("id", config.id)
    if (previous !== config.id) {
      Extension.sendToBackground(PortName.Events, {
        request: {
          event: EventType.ModelChanged,
          data: { model: configManager.getCurrentModel(config) }
        }
      })
    }
  }

  async getDefault(): Promise<Config> {
    const id = (await this.defaultConfig.get("id")) as string | undefined
    if (id) {
      const config = await this.get(id)
      if (config) {
        return config
      }
      await this.defaultConfig.remove("id")
    }
    return this.getOrInit(AuthType.External)
  }

  // TODO: allow multiple custom models
  async forModelWithDefault(model?: string): Promise<Config> {
    if (!model) {
      return this.getDefault()
    }
    if (isKnownModel(model)) {
      return this.forModel(model)
    }
    // Local model handles unknowns
    return this.getOrInit(AuthType.APIKey)
  }

  // Filtering for `null` looks for configs that don't have any models
  async filter({
    auth,
    model
  }: {
    auth: AuthType
    model?: ModelID | null
  }): Promise<Config[]> {
    const ids = await this.getIds(100, 0, authIndexName, auth)
    const maybeConfigs = await Promise.all(ids.map((id) => this.get(id)))
    const configs = maybeConfigs.filter((c) => c !== undefined) as Config[]
    return configs.filter((c) =>
      model === null
        ? c.models.length === 0
        : model
        ? c.models.includes(model)
        : true
    )
  }

  async forAuthAndModel(auth: AuthType, modelId?: ModelID) {
    let forAuth: Config[]
    if (!modelId) {
      forAuth =
        auth === AuthType.APIKey
          ? await this.filter({ auth, model: null }) // Local model is special case (no model ID)
          : await this.filter({ auth })
    } else {
      forAuth = await this.filter({ auth, model: modelId })
    }
    return forAuth[0]
  }

  getCallerForAuth(auth: AuthType, modelId?: ModelID) {
    switch (auth) {
      case AuthType.External:
        return openrouter
      case AuthType.APIKey:
        return modelId ? modelAPICallers[modelId] : local
    }
  }

  getLabelForAuth(auth: AuthType, modelId?: ModelID) {
    switch (auth) {
      case AuthType.External:
        return "OpenRouter"
      case AuthType.APIKey:
        return modelId ? defaultAPILabel[modelId] : "Local"
    }
  }

  getCaller(config: Config) {
    return this.getCallerForAuth(config.auth, this.getCurrentModel(config))
  }

  getCurrentModel(config: Config): ModelID | undefined {
    // TODO: support multiple models per config
    if (config.models.length > 1) {
      return undefined
    }
    return config.models[0]
  }

  getExternalConfigURL(config: Config) {
    switch (config.auth) {
      case AuthType.External:
        return config.session?.settingsUrl ?? getExternalConfigURL()
      case AuthType.APIKey:
        const model = this.getCurrentModel(config)
        if (!model) {
          // Assume local model
          return "https://github.com/alexanderatallah/window.ai#-local-model-setup"
        }
        return APIKeyURL[model]
    }
  }
}

export const configManager = new ConfigManager()
