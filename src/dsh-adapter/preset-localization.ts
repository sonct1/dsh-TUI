import { t } from '../i18n.js'

const LIANGSHEN_NAME = '梁神模式'
const LIANGSHEN_DESCRIPTION = '主 Agent 与子 Agent 首轮均保持 Minimal 双工具，首次工具调用后开放完整目录，压缩后重新锚定。'

export interface PresetPresentation {
  id: string
  name?: string
  description?: string
}

export function localizeBundledPreset(preset: PresetPresentation): PresetPresentation {
  if (
    preset.id !== 'liangshen'
    || preset.name !== LIANGSHEN_NAME
    || preset.description !== LIANGSHEN_DESCRIPTION
  ) {
    return preset
  }
  return {
    ...preset,
    name: t('preset-liangshen-name'),
    description: t('preset-liangshen-description'),
  }
}
