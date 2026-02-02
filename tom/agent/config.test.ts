import { describe, it, expect } from 'vitest'

import {
  getAgentConfig,
  MEMORY_OPERATION_TOOLS,
  isMemoryOperationAllowed,
} from './config.js'

describe('getAgentConfig', () => {
  it('returns valid agent configuration', () => {
    const config = getAgentConfig()

    expect(config.name).toBe('tom-agent')
    expect(config.model).toBe('haiku')
    expect(config.temperature).toBe(0.1)
    expect(config.maxMemoryOperations).toBe(3)
    expect(config.tools).toHaveLength(5)
  })

  it('includes all 5 required tools', () => {
    const config = getAgentConfig()

    expect(config.tools).toContain('search_memory')
    expect(config.tools).toContain('read_memory_file')
    expect(config.tools).toContain('analyze_session')
    expect(config.tools).toContain('initialize_user_profile')
    expect(config.tools).toContain('give_suggestions')
  })

  it('points to system prompt file', () => {
    const config = getAgentConfig()
    expect(config.systemPromptPath).toBe('tom/agent/tom-agent.md')
  })
})

describe('MEMORY_OPERATION_TOOLS', () => {
  it('includes the 3 memory operation tools', () => {
    expect(MEMORY_OPERATION_TOOLS.has('search_memory')).toBe(true)
    expect(MEMORY_OPERATION_TOOLS.has('read_memory_file')).toBe(true)
    expect(MEMORY_OPERATION_TOOLS.has('analyze_session')).toBe(true)
  })

  it('does not include non-memory tools', () => {
    expect(MEMORY_OPERATION_TOOLS.has('initialize_user_profile')).toBe(false)
    expect(MEMORY_OPERATION_TOOLS.has('give_suggestions')).toBe(false)
  })
})

describe('isMemoryOperationAllowed', () => {
  it('allows operations below limit', () => {
    expect(isMemoryOperationAllowed(0)).toBe(true)
    expect(isMemoryOperationAllowed(1)).toBe(true)
    expect(isMemoryOperationAllowed(2)).toBe(true)
  })

  it('blocks operations at or above limit', () => {
    expect(isMemoryOperationAllowed(3)).toBe(false)
    expect(isMemoryOperationAllowed(4)).toBe(false)
  })

  it('respects custom max operations', () => {
    expect(isMemoryOperationAllowed(4, 5)).toBe(true)
    expect(isMemoryOperationAllowed(5, 5)).toBe(false)
  })
})
