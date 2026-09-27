import type { ChatCompletionTool } from 'openai/resources/index.js'
import * as createArtifact from './tools/create_artifact.js'
import * as updateArtifact from './tools/update_artifact.js'
import * as askQuestion from './tools/ask_question.js'
import * as askQuestionsBatch from './tools/ask_questions_batch.js'
import * as sendOutput from './tools/send_output.js'
import * as submitReview from './tools/submit_review.js'
import * as getArtifact from './tools/get_artifact.js'
import * as listRepoTree from './tools/list_repo_tree.js'
import * as readRepoFile from './tools/read_repo_file.js'

export interface ToolContext {
  featureId: string
  stageRunId: string
  userId?: string
  role: 'author' | 'reviewer'
}

export type ToolHandler = (args: unknown, ctx: ToolContext) => Promise<unknown>

interface ToolDef {
  schema: ChatCompletionTool
  handler: ToolHandler
  role: 'author' | 'reviewer' | 'both'
}

const TOOLS: Record<string, ToolDef> = {
  create_artifact: { schema: createArtifact.schema, handler: createArtifact.handler, role: 'author' },
  update_artifact: { schema: updateArtifact.schema, handler: updateArtifact.handler, role: 'author' },
  ask_question: { schema: askQuestion.schema, handler: askQuestion.handler, role: 'author' },
  ask_questions_batch: { schema: askQuestionsBatch.schema, handler: askQuestionsBatch.handler, role: 'author' },
  send_output: { schema: sendOutput.schema, handler: sendOutput.handler, role: 'both' },
  submit_review: { schema: submitReview.schema, handler: submitReview.handler, role: 'reviewer' },
  get_artifact: { schema: getArtifact.schema, handler: getArtifact.handler, role: 'both' },
  list_repo_tree: { schema: listRepoTree.schema, handler: listRepoTree.handler, role: 'author' },
  read_repo_file: { schema: readRepoFile.schema, handler: readRepoFile.handler, role: 'author' },
}

export function getToolSchemas(role: 'author' | 'reviewer'): ChatCompletionTool[] {
  return Object.values(TOOLS)
    .filter((t) => t.role === 'both' || t.role === role)
    .map((t) => t.schema)
}

export async function dispatchTool(
  name: string,
  args: unknown,
  ctx: ToolContext,
): Promise<unknown> {
  const tool = TOOLS[name]
  if (!tool) throw new Error(`Unknown tool: ${name}`)
  if (tool.role !== 'both' && tool.role !== ctx.role) {
    throw new Error(`Tool ${name} is not available for role ${ctx.role}`)
  }
  // Validate required fields from schema before calling handler
  // Returns error object instead of throwing so LLM can retry with corrected args
  const required: string[] = (tool.schema.function.parameters as { required?: string[] }).required ?? []
  const argsObj = args as Record<string, unknown>
  const missing = required.filter((k) => argsObj[k] === undefined || argsObj[k] === null || argsObj[k] === '')
  if (missing.length > 0) {
    return { error: `Missing required field(s): ${missing.join(', ')}. Please call ${name} again with all required fields: ${required.join(', ')}.` }
  }
  return tool.handler(args, ctx)
}
