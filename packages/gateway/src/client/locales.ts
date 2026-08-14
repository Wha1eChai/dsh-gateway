/** Gateway product copy: Chinese is the default and English is complete. */
export const zh = Object.freeze({
  title: 'AI Gateway',
  description: '连接 CLIProxyAPI，并复用 DSH 原生模型 Provider。',
  foundation: 'Gateway 基座已就绪',
  loading: '正在读取运行状态…',
  unavailable: '暂时无法读取 Gateway 状态。',
  runtime: '运行时',
  mode: '模式',
  endpoint: '端点',
  managed: '受管',
  external: '外部',
  notConfigured: '未配置',
  close: '返回会话',
})

export const en = Object.freeze({
  title: 'AI Gateway',
  description: 'Connect CLIProxyAPI through the native DSH model provider.',
  foundation: 'Gateway foundation is ready',
  loading: 'Reading runtime status…',
  unavailable: 'Gateway status is currently unavailable.',
  runtime: 'Runtime',
  mode: 'Mode',
  endpoint: 'Endpoint',
  managed: 'Managed',
  external: 'External',
  notConfigured: 'Not configured',
  close: 'Back to conversation',
})

export type GatewayLocaleKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    gateway: GatewayLocaleKey
  }
}
