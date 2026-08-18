/**
 * Re-export of the `dsh-working-activity` plugin under this package's own
 * name, so the bundle patch layer can mount the working-activity row as
 * `@deepseek-harness-tui/dsh-tui/working-activity` instead of the bare package name.
 *
 * The dsh Loader resolves row names from the *profile* directory
 * (`~/.dsh/profiles/<name>/`): only the profile's direct dependencies are
 * linked into its node_modules. npm's flat layout also hoists transitive
 * dependencies there, but pnpm's isolated layout never does — so the bare
 * `dsh-working-activity` name (a transitive dependency of @deepseek-harness-tui/dsh-tui) fails
 * with ERR_MODULE_NOT_FOUND at boot and the loader disposes the whole app,
 * exiting the TUI before any UI appears (issue #60). Mounting through this
 * subpath keeps resolution anchored at @deepseek-harness-tui/dsh-tui itself — always a direct
 * profile dependency — and from its real location `dsh-working-activity`
 * resolves under every package-manager layout.
 *
 * `publish` is forced off at this mount point: the TUI derives its working
 * line in-process (issue #143) and never wants activity/status snapshots in
 * the session log — they make the shared JSONL unreadable for Web (issue
 * #153). A stale global-launcher patch (≤0.6.x, resolved anchor-first by
 * the dsh CLI) still carries `publish: true` on this row, which re-enabled
 * the pollution even on an up-to-date profile install. A local `apply`
 * shadows the star re-export, so the row config can never turn publishing
 * back on; a log-replaying consumer mounts the bare package instead.
 * @module @deepseek-harness-tui/dsh-tui/working-activity
 */
import { apply as mountedApply } from 'dsh-working-activity'
import { getLang } from './i18n.js'

export * from 'dsh-working-activity'

// Types derive from the mounted plugin's own signature: importing
// @deepseek-ai/cordis here would violate the adapter boundary gate.
type MountedContext = Parameters<typeof mountedApply>[0]

type SystemPromptLike = {
  section(section: { name: string; order: number; text: () => string }): () => void
}

const NARRATE_ZH =
  '[状态栏] 你有一个状态栏展示给用户。【必须】在每个步骤/子任务开始时（不只是调用工具前），在回复正文的最前面单独写一行：⏵ 你在做的具体事情（不超过20字），然后换行继续正常回复。整轮回复只写一行 ⏵，不要重复。信息为主——让人一眼知道你在干什么，风格自然、可以带点俏皮。例：⏵ 修复登录页样式、⏵ 查一下报错原因、⏵ 给补丁跑个验证。切换任务时必须更新。'

const NARRATE_EN =
  '[Status bar] You have a status bar visible to the user. At the start of each step or subtask, put exactly one standalone line at the very beginning of the response: ⏵ followed by a concrete description of what you are doing, no more than 12 English words. Then continue the normal response on the next line. Write this status line in English only, even when the user or repository uses another language. Keep it informative and natural. Examples: ⏵ Fixing the login page styles, ⏵ Investigating the error cause, ⏵ Running verification on the patch.'

export const apply = (ctx: MountedContext, config: Parameters<typeof mountedApply>[1]): void => {
  // The upstream plugin ships one hard-coded Chinese narration section. Mount
  // its activity/event machinery with narration disabled, then contribute the
  // same section dynamically so /lang hot-switches affect the next assembly.
  mountedApply(ctx, { ...config, publish: false, narrate: false })
  ctx.inject(['systemPrompt'], (promptCtx) => {
    const systemPrompt = promptCtx.systemPrompt as SystemPromptLike
    systemPrompt.section({
      name: 'working-activity:narrate',
      order: 60,
      text: () => getLang() === 'en' ? NARRATE_EN : NARRATE_ZH,
    })
  })
}
