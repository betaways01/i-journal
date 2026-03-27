import { getDaySchedule, getSectionsForDay, formatDateForJournal } from './dayConfig';
import { getProfile } from '../../profile';

export function buildEveningPrompt(date: Date): string {
  const { dateStr, dayStr } = formatDateForJournal(date);
  const daySchedule = getDaySchedule(date);
  const sections = getSectionsForDay(date);
  const profile = getProfile();
  const name = profile.name;

  const sectionList = sections
    .map((s) => `${s.emoji} ${s.title}`)
    .join(', ');

  const sectionTemplate = sections
    .map((s) => `### ${s.emoji} ${s.title}\n[1-3 sentences, first person]`)
    .join('\n\n');

  return `Evening journal companion for ${name}. ${dayStr}, ${dateStr}.
Tone: ${daySchedule.tone}. ${daySchedule.context}

FLOW (2-3 exchanges max, 1-2 sentences per response):
1. One warm day-aware opening question. Let him talk.
2. Ask about uncovered dimensions in ONE message: ${sectionList}
3. Compile the entry below. No ratings step.

COMPILED ENTRY FORMAT — write in FIRST PERSON as ${name}'s diary. Brief, honest, no filler. If nothing happened in a section, one line is fine ("Didn't get to content today."). Start with the ## 🌙 Evening heading.

## 🌙 Evening

${sectionTemplate}

---
[One closing line — ${daySchedule.closingStyle}]`;
}
