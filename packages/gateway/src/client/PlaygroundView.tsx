import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent, ReactNode } from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  GatewayJsonValue,
  GatewayModelView,
  GatewayModelsView,
  GatewayProbeBlock,
  GatewayProbeImageRef,
  GatewayProbeRequest,
  GatewayProbeResult,
  GatewayProbeTool,
} from '@wha1echai/dsh-gateway/contracts'

import styles from './PlaygroundView.module.css'

const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_PROBE_TOKENS = 131_072
const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

type RemoteValue<T> = T | RemoteResult<T>
type ImageMediaType = GatewayProbeImageRef['mediaType']
type ImageUploadState = 'idle' | 'uploading' | 'error'
type ProbeState = 'idle' | 'running' | 'success' | 'error' | 'cancelled'

export interface PlaygroundImageUpload {
  /** A one-shot data URL. The view never stores this value in React state or browser storage. */
  readonly dataUrl: string
  readonly mediaType: ImageMediaType
  readonly bytes: number
  readonly name?: string
}

export interface PlaygroundLabels {
  readonly title: string
  readonly description: string
  readonly model: string
  readonly selectModel: string
  readonly loadingModels: string
  readonly modelsUnavailable: string
  readonly noModels: string
  readonly prompt: string
  readonly promptPlaceholder: string
  readonly image: string
  readonly chooseImage: string
  readonly imageHint: string
  readonly removeImage: string
  readonly imageUploading: string
  readonly invalidImageType: string
  readonly imageTooLarge: string
  readonly uploadFailed: string
  readonly imageUnsupported: string
  readonly maxTokens: string
  readonly maxTokensHint: string
  readonly toolSchema: string
  readonly toolSchemaHint: string
  readonly run: string
  readonly cancel: string
  readonly running: string
  readonly result: string
  readonly textBlock: string
  readonly reasoningBlock: string
  readonly toolCallBlock: string
  readonly toolName: string
  readonly toolArguments: string
  readonly usage: string
  readonly inputTokens: string
  readonly outputTokens: string
  readonly cacheReadTokens: string
  readonly cacheWriteTokens: string
  readonly reasoningTokens: string
  readonly finish: string
  readonly error: string
  readonly unavailable: string
  readonly cancelled: string
  readonly invalidPrompt: string
  readonly invalidMaxTokens: string
}

export interface PlaygroundViewProps {
  readonly labels: PlaygroundLabels
  readonly loadModels: (signal?: AbortSignal) => Promise<RemoteValue<GatewayModelsView>>
  readonly uploadImage: (image: PlaygroundImageUpload) => Promise<RemoteValue<GatewayProbeImageRef>>
  readonly runProbe: (request: GatewayProbeRequest, signal?: AbortSignal) => Promise<RemoteValue<GatewayProbeResult>>
}

const SAFE_ECHO_TOOL: GatewayProbeTool = {
  name: 'echo',
  description: 'Returns the supplied value without side effects.',
  parameters: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  } satisfies Readonly<Record<string, GatewayJsonValue>>,
}

function unwrapRemoteValue<T>(result: RemoteValue<T>): T | undefined {
  if (typeof result === 'object' && result !== null && 'ok' in result && typeof result.ok === 'boolean') {
    return result.ok ? result.value : undefined
  }
  return result
}

function isImageMediaType(value: string): value is ImageMediaType {
  return (IMAGE_MEDIA_TYPES as readonly string[]).includes(value)
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('image_read_failed'))
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('image_read_failed'))
    }
    reader.readAsDataURL(file)
  })
}

function safeFileName(name: string): string | undefined {
  const value = name.replace(/[\\/]/g, '').trim().slice(0, 128)
  return value.length === 0 ? undefined : value
}

function blockLabel(block: GatewayProbeBlock, labels: PlaygroundLabels): string {
  if (block.type === 'text') return labels.textBlock
  if (block.type === 'reasoning') return labels.reasoningBlock
  return labels.toolCallBlock
}

/** One-shot model probe UI. It carries only opaque image refs after upload. */
export function PlaygroundView({ labels, loadModels, uploadImage, runProbe }: PlaygroundViewProps): ReactNode {
  const [models, setModels] = useState<readonly GatewayModelView[]>([])
  const [modelState, setModelState] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  const [selectedModel, setSelectedModel] = useState('')
  const [prompt, setPrompt] = useState('')
  const [image, setImage] = useState<GatewayProbeImageRef | undefined>()
  const [imageState, setImageState] = useState<ImageUploadState>('idle')
  const [imageError, setImageError] = useState<'type' | 'size' | 'upload' | undefined>()
  const [maxTokens, setMaxTokens] = useState('')
  const [includeTool, setIncludeTool] = useState(false)
  const [probeState, setProbeState] = useState<ProbeState>('idle')
  const [probeResult, setProbeResult] = useState<GatewayProbeResult | undefined>()
  const [probeError, setProbeError] = useState<string | undefined>()
  const mounted = useRef(true)
  const probeId = useRef(0)
  const probeController = useRef<AbortController | undefined>()
  const uploadId = useRef(0)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      probeId.current += 1
      probeController.current?.abort()
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setModelState('loading')
    void loadModels(controller.signal).then((response) => {
      if (!active || !mounted.current) return
      const view = unwrapRemoteValue(response)
      if (view === undefined) {
        setModels([])
        setModelState('unavailable')
        return
      }
      setModels(view.models)
      setModelState('ready')
    }, () => {
      if (!active || !mounted.current) return
      setModels([])
      setModelState('unavailable')
    })
    return () => {
      active = false
      controller.abort()
    }
  }, [loadModels])

  useEffect(() => {
    setSelectedModel((current) => models.some((model) => model.id === current) ? current : (models[0]?.id ?? ''))
  }, [models])

  const selectedModelView = models.find((model) => model.id === selectedModel)
  const imageAllowed = selectedModelView?.imageInput === true

  useEffect(() => {
    if (!imageAllowed && image !== undefined) setImage(undefined)
  }, [image, imageAllowed])

  const prepareImage = async (file: File): Promise<void> => {
    const currentUploadId = uploadId.current + 1
    uploadId.current = currentUploadId
    setImage(undefined)
    setImageError(undefined)
    if (!isImageMediaType(file.type)) {
      setImageState('error')
      setImageError('type')
      return
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setImageState('error')
      setImageError('size')
      return
    }

    setImageState('uploading')
    let dataUrl = ''
    try {
      dataUrl = await readAsDataUrl(file)
      if (!mounted.current || uploadId.current !== currentUploadId) return
      const name = safeFileName(file.name)
      const response = await uploadImage({
        dataUrl,
        mediaType: file.type,
        bytes: file.size,
        ...(name === undefined ? {} : { name }),
      })
      if (!mounted.current || uploadId.current !== currentUploadId) return
      const reference = unwrapRemoteValue(response)
      if (reference === undefined) {
        setImageState('error')
        setImageError('upload')
        return
      }
      setImage(reference)
      setImageState('idle')
    } catch {
      if (mounted.current && uploadId.current === currentUploadId) {
        setImageState('error')
        setImageError('upload')
      }
    } finally {
      // Do not retain the data URL in component state, refs, storage, or the URL.
      dataUrl = ''
    }
  }

  const handleImageChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file !== undefined) void prepareImage(file)
  }

  const handleCancel = (): void => {
    if (probeState !== 'running') return
    probeId.current += 1
    probeController.current?.abort()
    probeController.current = undefined
    setProbeState('cancelled')
    setProbeResult(undefined)
    setProbeError(labels.cancelled)
  }

  const handleRun = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (probeState === 'running') return
    if (prompt.trim().length === 0) {
      setProbeState('error')
      setProbeResult(undefined)
      setProbeError(labels.invalidPrompt)
      return
    }
    if (selectedModel.length === 0) {
      setProbeState('error')
      setProbeResult(undefined)
      setProbeError(labels.modelsUnavailable)
      return
    }

    let parsedMaxTokens: number | undefined
    if (maxTokens.trim().length > 0) {
      parsedMaxTokens = Number(maxTokens)
      if (!Number.isSafeInteger(parsedMaxTokens) || parsedMaxTokens < 1 || parsedMaxTokens > MAX_PROBE_TOKENS) {
        setProbeState('error')
        setProbeResult(undefined)
        setProbeError(labels.invalidMaxTokens)
        return
      }
    }

    const request: GatewayProbeRequest = {
      model: selectedModel,
      prompt,
      ...(image === undefined ? {} : { image }),
      ...(includeTool ? { tools: [SAFE_ECHO_TOOL] } : {}),
      ...(parsedMaxTokens === undefined ? {} : { maxTokens: parsedMaxTokens }),
    }
    const currentProbeId = probeId.current + 1
    probeId.current = currentProbeId
    const controller = new AbortController()
    probeController.current = controller
    setProbeState('running')
    setProbeResult(undefined)
    setProbeError(undefined)

    void runProbe(request, controller.signal).then((response) => {
      if (!mounted.current || probeId.current !== currentProbeId) return
      const result = unwrapRemoteValue(response)
      if (result === undefined) {
        setProbeState('error')
        setProbeError(labels.unavailable)
        return
      }
      setProbeResult(result)
      if (result.ok) {
        setProbeState('success')
        setProbeError(undefined)
      } else {
        const status = result.error.status === undefined ? '' : ` (${result.error.status})`
        setProbeState('error')
        setProbeError(`${result.error.code}${status}`)
      }
    }, () => {
      if (!mounted.current || probeId.current !== currentProbeId) return
      setProbeState('error')
      setProbeError(labels.unavailable)
    }).finally(() => {
      if (mounted.current && probeId.current === currentProbeId) {
        probeController.current = undefined
      }
    })
  }

  const canRun = modelState === 'ready' && selectedModel.length > 0 && prompt.trim().length > 0 && probeState !== 'running'
  const uploadMessage = imageState === 'uploading'
    ? labels.imageUploading
    : imageError === 'type'
      ? labels.invalidImageType
      : imageError === 'size'
        ? labels.imageTooLarge
        : imageError === 'upload'
          ? labels.uploadFailed
          : undefined

  return (
    <article className={styles.page} data-gateway-view="playground">
      <header className={styles.header}>
        <h1 className={styles.title}>{labels.title}</h1>
        <p className={styles.description}>{labels.description}</p>
      </header>

      <form className={styles.form} onSubmit={handleRun}>
        <label className={styles.field} htmlFor="gateway-playground-model">
          <span>{labels.model}</span>
          <select
            id="gateway-playground-model"
            className={styles.input}
            value={selectedModel}
            onChange={(event) => setSelectedModel(event.target.value)}
            disabled={modelState !== 'ready' || models.length === 0 || probeState === 'running'}
            aria-label={labels.selectModel}
          >
            <option value="">{modelState === 'loading' ? labels.loadingModels : labels.selectModel}</option>
            {models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
          </select>
        </label>

        <div className={styles.status} aria-live="polite" aria-busy={modelState === 'loading'}>
          {modelState === 'loading' && <p>{labels.loadingModels}</p>}
          {modelState === 'unavailable' && <p role="alert">{labels.modelsUnavailable}</p>}
          {modelState === 'ready' && models.length === 0 && <p>{labels.noModels}</p>}
          {modelState === 'ready' && !imageAllowed && <p>{labels.imageUnsupported}</p>}
        </div>

        <label className={styles.field} htmlFor="gateway-playground-prompt">
          <span>{labels.prompt}</span>
          <textarea
            id="gateway-playground-prompt"
            className={`${styles.input} ${styles.prompt}`}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={labels.promptPlaceholder}
            rows={6}
            disabled={probeState === 'running'}
          />
        </label>

        <fieldset className={styles.group}>
          <legend>{labels.image}</legend>
          <div className={styles.imageControls}>
            <input
              id="gateway-playground-image"
              className={styles.fileInput}
              type="file"
              accept={IMAGE_MEDIA_TYPES.join(',')}
              onChange={handleImageChange}
              disabled={!imageAllowed || imageState === 'uploading' || probeState === 'running'}
              aria-describedby="gateway-playground-image-hint"
            />
            <label className={styles.fileButton} htmlFor="gateway-playground-image">
              {labels.chooseImage}
            </label>
            {image !== undefined && (
              <button type="button" className={styles.textButton} onClick={() => setImage(undefined)} disabled={probeState === 'running'}>
                {labels.removeImage}
              </button>
            )}
          </div>
          <p id="gateway-playground-image-hint" className={styles.help}>{labels.imageHint}</p>
          {uploadMessage !== undefined && <p className={styles.error} role="alert">{uploadMessage}</p>}
          {image !== undefined && <p className={styles.help}>{image.name ?? image.mediaType}</p>}
        </fieldset>

        <div className={styles.options}>
          <label className={styles.field} htmlFor="gateway-playground-max-tokens">
            <span>{labels.maxTokens}</span>
            <input
              id="gateway-playground-max-tokens"
              className={styles.input}
              type="number"
              min={1}
              max={MAX_PROBE_TOKENS}
              step={1}
              inputMode="numeric"
              value={maxTokens}
              onChange={(event) => setMaxTokens(event.target.value)}
              disabled={probeState === 'running'}
              aria-describedby="gateway-playground-max-tokens-hint"
            />
            <span id="gateway-playground-max-tokens-hint" className={styles.help}>{labels.maxTokensHint}</span>
          </label>

          <label className={styles.checkbox} htmlFor="gateway-playground-tool">
            <input
              id="gateway-playground-tool"
              type="checkbox"
              checked={includeTool}
              onChange={(event) => setIncludeTool(event.target.checked)}
              disabled={probeState === 'running'}
            />
            <span>
              <span className={styles.checkboxTitle}>{labels.toolSchema}</span>
              <span className={styles.help}>{labels.toolSchemaHint}</span>
            </span>
          </label>
        </div>

        <div className={styles.actions}>
          <button type="submit" className={styles.primaryButton} disabled={!canRun} aria-busy={probeState === 'running'}>
            {probeState === 'running' ? labels.running : labels.run}
          </button>
          {probeState === 'running' && <button type="button" className={styles.button} onClick={handleCancel}>{labels.cancel}</button>}
        </div>
      </form>

      <section className={styles.output} aria-live={probeState === 'running' ? 'polite' : undefined}>
        <h2 className={styles.sectionTitle}>{labels.result}</h2>
        {probeState === 'running' && <p className={styles.help}>{labels.running}</p>}
        {probeState === 'cancelled' && <p className={styles.help}>{labels.cancelled}</p>}
        {probeState === 'error' && <p className={styles.error} role="alert">{labels.error}: {probeError ?? labels.unavailable}</p>}
        {probeResult?.ok === true && (
          <>
            <div className={styles.blocks}>
              {probeResult.blocks.map((block, index) => (
                <article className={styles.block} key={`${block.type}:${index}`}>
                  <h3 className={styles.blockTitle}>{blockLabel(block, labels)}</h3>
                  {block.type === 'tool-call' ? (
                    <dl className={styles.toolCall}>
                      <div><dt>{labels.toolName}</dt><dd>{block.name}</dd></div>
                      <div><dt>{labels.toolArguments}</dt><dd><pre>{block.arguments}</pre></dd></div>
                    </dl>
                  ) : <p className={styles.blockText}>{block.text}</p>}
                </article>
              ))}
            </div>
            <dl className={styles.usage}>
              <div><dt>{labels.finish}</dt><dd>{probeResult.finish}</dd></div>
              {probeResult.usage !== undefined && <>
                <div><dt>{labels.inputTokens}</dt><dd>{probeResult.usage.inputTokens}</dd></div>
                <div><dt>{labels.outputTokens}</dt><dd>{probeResult.usage.outputTokens}</dd></div>
                {probeResult.usage.cacheReadTokens !== undefined && <div><dt>{labels.cacheReadTokens}</dt><dd>{probeResult.usage.cacheReadTokens}</dd></div>}
                {probeResult.usage.cacheWriteTokens !== undefined && <div><dt>{labels.cacheWriteTokens}</dt><dd>{probeResult.usage.cacheWriteTokens}</dd></div>}
                {probeResult.usage.reasoningTokens !== undefined && <div><dt>{labels.reasoningTokens}</dt><dd>{probeResult.usage.reasoningTokens}</dd></div>}
              </>}
            </dl>
          </>
        )}
      </section>
    </article>
  )
}
