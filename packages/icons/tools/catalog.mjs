import * as actions from '../dist/actions.js';
import * as arrows from '../dist/arrows.js';
import * as files from '../dist/files.js';
import * as git from '../dist/git.js';
import * as layout from '../dist/layout.js';
import * as status from '../dist/status.js';
import * as skills from '../dist/skills.js';
import * as knowledge from '../dist/knowledge.js';
import { ChangesIcon, VisualizeIcon, WorktreeIcon } from '../dist/index.js';

const groups = {
  Skills: skills,
  Knowledge: knowledge,
  Status: status,
  Actions: actions,
  Arrows: arrows,
  Files: files,
  Git: git,
  Layout: layout,
  Identity: { ChangesIcon, VisualizeIcon, WorktreeIcon },
};

export const catalog = Object.entries(groups).flatMap(([category, icons]) =>
  Object.entries(icons).map(([name, component]) => ({
    name,
    category,
    component,
    slug: name
      .replace(/Icon$/, '')
      .replace(/[A-Z]/g, (letter, index) => `${index ? '-' : ''}${letter.toLowerCase()}`),
    variant: name.endsWith('Filled') ? 'filled' : 'outline',
  })),
);

export const featured = [
  { name: 'Rosette', label: 'Skills', tone: 'rose' },
  { name: 'Hierarchy', label: 'Workflows', tone: 'green' },
  { name: 'Ghost', label: 'Agents', tone: 'orange' },
  { name: 'MessageBubble', label: 'Conversations', tone: 'blue' },
  { name: 'ConnectedNodes', label: 'Connections', tone: 'sand' },
  { name: 'Gauge', label: 'Performance', tone: 'violet' },
  { name: 'AlertTriangle', label: 'Attention', tone: 'amber' },
];
