export interface SkillActivation {
  skillName: string;
  prompt: string;
  message: string;
}

export function parseSkillActivation(text: string): SkillActivation | undefined {
  const match = /^Skill "([^"\r\n]+)" activated(?:: ([\s\S]*))?$/.exec(text.trim());
  if (!match) return undefined;
  const skillName = match[1];
  const prompt = match[2]?.trim() ?? '';
  return {
    skillName,
    prompt,
    message: `Skill "${skillName}" activated${prompt ? `: ${prompt}` : ''}`,
  };
}
