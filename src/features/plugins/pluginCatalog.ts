export type PluginKind = 'connector' | 'skill-pack';
export type PluginAdapter = 'github-cli' | 'droid-plugin';
export type PluginIconKey =
  | 'github'
  | 'droid-control'
  | 'droid-evolved'
  | 'security'
  | 'typescript'
  | 'debugging'
  | 'code-review'
  | 'autoresearch';

export interface PluginMarketplace {
  id: string;
  cliName: string;
  name: string;
  sourceUrl: string;
  description: string;
}

export interface PluginDefinition {
  id: string;
  slug: string;
  name: string;
  description: string;
  longDescription: string;
  publisher: string;
  category: string;
  kind: PluginKind;
  adapter: PluginAdapter;
  icon: PluginIconKey;
  brandColor: string;
  featured?: boolean;
  marketplaceId?: string;
  installId?: string;
  legacyInstallId?: string;
  promptExample: string;
  semanticSummary: string;
  app?: {
    name: string;
    description: string;
  };
  skills: Array<{
    name: string;
    description: string;
  }>;
  capabilities: string[];
  permissions: string[];
}

export const FACTORY_MARKETPLACE: PluginMarketplace = {
  id: 'factory-official',
  cliName: 'factory-plugins',
  name: 'Factory Official',
  sourceUrl: 'https://github.com/Factory-AI/factory-plugins',
  description: 'Factory-maintained plugins for Droid.',
};

export const PLUGIN_CATALOG: PluginDefinition[] = [
  {
    id: 'builtin/github',
    slug: 'github',
    name: 'GitHub',
    description: 'Triage pull requests, issues, checks, and repository work.',
    longDescription:
      'Use DROIDEX’s native GitHub connection for repository search, pull-request review, issue work, checks, and authenticated gh workflows. This replaces the old Claude-compatible GitHub MCP package that required GITHUB_PERSONAL_ACCESS_TOKEN.',
    publisher: 'GitHub',
    category: 'Development',
    kind: 'connector',
    adapter: 'github-cli',
    icon: 'github',
    brandColor: '#f0f0f0',
    featured: true,
    legacyInstallId: 'github@claude-plugins-official',
    promptExample: 'Inspect the open pull request, triage its review comments, and check CI.',
    semanticSummary:
      'GitHub repositories, pull requests, issues, checks, reviews, commits, branches, and authenticated gh workflows.',
    app: {
      name: 'GitHub',
      description: 'Repositories, pull requests, issues, and CI through your authenticated GitHub CLI session.',
    },
    skills: [
      {
        name: 'GitHub workflows',
        description: 'Inspect PRs, triage issues, check CI, and prepare repository changes.',
      },
    ],
    capabilities: ['Interactive', 'Read', 'Write'],
    permissions: [
      'Uses the existing DROIDEX GitHub CLI authentication flow.',
      'Repository writes still follow the active harness approval and autonomy policy.',
    ],
  },
  {
    id: 'factory/droid-control',
    slug: 'droid-control',
    name: 'Droid Control',
    description: 'Browser, terminal, and desktop automation for testing and demos.',
    longDescription:
      'Adds controlled browser, terminal, and computer-use workflows for end-to-end testing, QA, product verification, screenshots, and demos.',
    publisher: 'Factory',
    category: 'Automation',
    kind: 'skill-pack',
    adapter: 'droid-plugin',
    icon: 'droid-control',
    brandColor: '#f59e0b',
    featured: true,
    marketplaceId: FACTORY_MARKETPLACE.id,
    installId: 'droid-control@factory-plugins',
    promptExample: 'Verify the onboarding flow and report every broken or confusing state.',
    semanticSummary:
      'Browser automation, terminal workflows, computer use, QA, product verification, screenshots, and demos.',
    skills: [
      { name: 'Browser automation', description: 'Exercise real interfaces and capture evidence.' },
      { name: 'Terminal QA', description: 'Run setup, checks, and repeatable verification flows.' },
    ],
    capabilities: ['Interactive', 'Read', 'Write'],
    permissions: ['Uses browser, terminal, and computer tools only when the active harness permits them.'],
  },
  {
    id: 'factory/droid-evolved',
    slug: 'droid-evolved',
    name: 'Droid Evolved',
    description: 'Focused writing, design, browser, and reusable-skill workflows.',
    longDescription:
      'A focused collection of Factory skills for human-facing writing, visual design, frontend refinement, browser work, session navigation, and creating reusable skills.',
    publisher: 'Factory',
    category: 'Productivity',
    kind: 'skill-pack',
    adapter: 'droid-plugin',
    icon: 'droid-evolved',
    brandColor: '#a78bfa',
    featured: true,
    marketplaceId: FACTORY_MARKETPLACE.id,
    installId: 'droid-evolved@factory-plugins',
    promptExample: 'Refine this interface without changing its product hierarchy.',
    semanticSummary:
      'Visual design, frontend polish, human writing, skill creation, browser work, and session navigation.',
    skills: [
      { name: 'Visual design', description: 'Refine hierarchy, spacing, type, and interaction polish.' },
      { name: 'Human writing', description: 'Produce direct, natural product and communication copy.' },
      { name: 'Skill creation', description: 'Create and improve reusable agent skills.' },
    ],
    capabilities: ['Read', 'Write'],
    permissions: ['Loads focused instructions only when a matching skill is selected or discovered.'],
  },
  {
    id: 'factory/security-engineer',
    slug: 'security-engineer',
    name: 'Security Engineer',
    description: 'Threat modeling, security review, and vulnerability validation.',
    longDescription:
      'Adds security-focused procedures for reviewing code and architecture, building threat models, validating exploitability, and separating real risk from noisy findings.',
    publisher: 'Factory',
    category: 'Security',
    kind: 'skill-pack',
    adapter: 'droid-plugin',
    icon: 'security',
    brandColor: '#ef4444',
    featured: true,
    marketplaceId: FACTORY_MARKETPLACE.id,
    installId: 'security-engineer@factory-plugins',
    promptExample: 'Review this authentication change for practical exploit paths.',
    semanticSummary:
      'Security review, threat modeling, vulnerability analysis, exploit validation, and secure design.',
    skills: [
      { name: 'Security review', description: 'Inspect code and architecture for practical risks.' },
      { name: 'Threat modeling', description: 'Identify assets, trust boundaries, and attack paths.' },
    ],
    capabilities: ['Read', 'Write'],
    permissions: ['May inspect repository files and run validation commands when permitted.'],
  },
  {
    id: 'factory/typescript',
    slug: 'typescript',
    name: 'TypeScript',
    description: 'Production TypeScript and React quality patterns.',
    longDescription:
      'Provides focused TypeScript and React conventions for safer narrowing, clearer contracts, derived state, effect cleanup, and unused-export review.',
    publisher: 'Factory',
    category: 'Quality',
    kind: 'skill-pack',
    adapter: 'droid-plugin',
    icon: 'typescript',
    brandColor: '#3178c6',
    marketplaceId: FACTORY_MARKETPLACE.id,
    installId: 'typescript@factory-plugins',
    promptExample: 'Review this state layer for unsafe assertions and effect-driven state.',
    semanticSummary:
      'TypeScript, React, type safety, state modeling, effect cleanup, and unused exports.',
    skills: [
      { name: 'Type safety', description: 'Strengthen narrowing, contracts, and runtime boundaries.' },
      { name: 'React state', description: 'Prefer derived state over avoidable synchronization effects.' },
    ],
    capabilities: ['Read', 'Write'],
    permissions: ['Reads and edits source files through the active harness tool policy.'],
  },
  {
    id: 'factory/debugging',
    slug: 'debugging',
    name: 'Debugging',
    description: 'Trace runtime, HTTP, CLI, and service integration failures.',
    longDescription:
      'Adds practical debugging workflows for observing runtime behavior, inspecting HTTP traffic, and understanding difficult CLI and service failures at the wire level.',
    publisher: 'Factory',
    category: 'Productivity',
    kind: 'skill-pack',
    adapter: 'droid-plugin',
    icon: 'debugging',
    brandColor: '#22c55e',
    marketplaceId: FACTORY_MARKETPLACE.id,
    installId: 'debugging@factory-plugins',
    promptExample: 'Trace why this OAuth callback intermittently fails.',
    semanticSummary:
      'Runtime debugging, HTTP interception, network traffic, CLI failures, and integration diagnostics.',
    skills: [
      { name: 'Runtime debugging', description: 'Observe request and process behavior.' },
      { name: 'Traffic capture', description: 'Collect wire-level evidence for failures.' },
    ],
    capabilities: ['Read', 'Write'],
    permissions: ['May run local inspection commands when terminal access is approved.'],
  },
  {
    id: 'factory/code-review',
    slug: 'code-review',
    name: 'Code Review',
    description: 'Create and follow pull requests until they are merge-ready.',
    longDescription:
      'Adds structured pull-request lifecycle workflows for writing clear PRs, inspecting feedback, resolving actionable comments, and checking merge readiness.',
    publisher: 'Factory',
    category: 'Productivity',
    kind: 'skill-pack',
    adapter: 'droid-plugin',
    icon: 'code-review',
    brandColor: '#8b5cf6',
    marketplaceId: FACTORY_MARKETPLACE.id,
    installId: 'code-review@factory-plugins',
    promptExample: 'Inspect the open PR and resolve only the actionable review comments.',
    semanticSummary:
      'Pull requests, code review feedback, merge readiness, PR descriptions, and review follow-up.',
    skills: [
      { name: 'PR creation', description: 'Prepare consistent pull-request descriptions.' },
      { name: 'Review follow-up', description: 'Resolve feedback and re-check readiness.' },
    ],
    capabilities: ['Read', 'Write'],
    permissions: ['Git and GitHub writes still follow the active harness approval policy.'],
  },
  {
    id: 'factory/autoresearch',
    slug: 'autoresearch',
    name: 'Autoresearch',
    description: 'Run measured experiment loops and retain improvements that work.',
    longDescription:
      'A research loop for trying an idea, measuring the result, keeping useful changes, discarding regressions, and repeating with an evidence trail.',
    publisher: 'Factory',
    category: 'Research',
    kind: 'skill-pack',
    adapter: 'droid-plugin',
    icon: 'autoresearch',
    brandColor: '#06b6d4',
    marketplaceId: FACTORY_MARKETPLACE.id,
    installId: 'autoresearch@factory-plugins',
    promptExample: 'Reduce renderer startup time without increasing memory.',
    semanticSummary:
      'Iterative experiments, optimization research, measured improvements, and benchmark-driven loops.',
    skills: [
      { name: 'Experiment loop', description: 'Try, measure, keep, discard, and repeat.' },
      { name: 'Benchmark review', description: 'Compare outcomes and reject regressions.' },
    ],
    capabilities: ['Read', 'Write'],
    permissions: ['Executes experiments according to the current autonomy and tool policy.'],
  },
];

export const PLUGIN_CATEGORIES = [
  'Development',
  'Productivity',
  'Automation',
  'Quality',
  'Security',
  'Research',
] as const;

export function pluginById(id: string): PluginDefinition | undefined {
  return PLUGIN_CATALOG.find((plugin) => plugin.id === id);
}

export function pluginBySlug(slug: string): PluginDefinition | undefined {
  return PLUGIN_CATALOG.find((plugin) => plugin.slug === slug);
}

export function pluginsForCategory(category: string): PluginDefinition[] {
  return PLUGIN_CATALOG.filter((plugin) => plugin.category === category);
}
