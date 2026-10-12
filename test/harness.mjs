/**
 * 测试辅助：用真实的 defineTool 配一个假的工具注册表。
 *
 * 目的：不启动完整 dsh，也能验证「工具定义」这一层是真的 ——
 * `defineTool` 会把参数/输出规格转成 JSON Schema 并做合法性校验，
 * 把 ctx.tools.register 换成记录器即可拿到转换后的契约。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

export function createFakeRegistry() {
  const definitions = new Map()
  const disposed = []
  const ctx = {
    tools: {
      register(definition) {
        definitions.set(definition.name, definition)
        return () => {
          definitions.delete(definition.name)
          disposed.push(definition.name)
        }
      }
    }
  }
  return { ctx, definitions, disposed }
}

/** 工具的 execute 只用到 agent.session.id 与 signal */
export function executionContext(sessionId = 'test-session', signal = undefined) {
  return { agent: { session: { id: sessionId } }, signal }
}

export { defineTool }
