import type { BrowserSettingsSnapshot, BrowserSiteGrantKind } from '../../lib/browserSettings';
import {
  BrowserOriginList,
  BrowserSettingsCard,
  BrowserSettingsGroup,
} from './BrowserSettingsPrimitives';

const PERMISSION_CARDS: {
  kind: 'camera' | 'microphone';
  state: 'allow' | 'deny';
  label: string;
  description: string;
}[] = [
  {
    kind: 'microphone',
    state: 'allow',
    label: 'Allowed microphone',
    description:
      'Remembered exact-site choices that can use the microphone without another DROIDEX prompt.',
  },
  {
    kind: 'microphone',
    state: 'deny',
    label: 'Blocked microphone',
    description: 'Remembered exact-site choices that cannot use the microphone.',
  },
  {
    kind: 'camera',
    state: 'allow',
    label: 'Allowed camera',
    description:
      'Remembered exact-site choices that can use the camera without another DROIDEX prompt.',
  },
  {
    kind: 'camera',
    state: 'deny',
    label: 'Blocked camera',
    description: 'Remembered exact-site choices that cannot use the camera.',
  },
];

function GrantCard({
  label,
  description,
  sites,
  emptyLabel,
  kind,
  disabled,
  onRevoke,
}: {
  label: string;
  description: string;
  sites: string[];
  // Omitted by the camera and microphone cards: they stay hidden until a site is remembered.
  emptyLabel?: string;
  kind: BrowserSiteGrantKind;
  disabled: boolean;
  onRevoke: (kind: BrowserSiteGrantKind, origin: string) => void;
}) {
  if (sites.length === 0 && emptyLabel === undefined) return null;
  return (
    <BrowserSettingsCard>
      <div className="border-b border-droid-border/50 px-4 py-3">
        <div className="text-[12.5px] text-droid-text">{label}</div>
        <p className="mt-0.5 text-[11px] leading-4 text-droid-text-muted">{description}</p>
      </div>
      <BrowserOriginList
        origins={sites}
        emptyLabel={emptyLabel ?? ''}
        listLabel={label}
        actionLabel="Remove"
        actionNoun="grant"
        disabled={disabled}
        onAction={(origin) => {
          onRevoke(kind, origin);
        }}
      />
    </BrowserSettingsCard>
  );
}

export function BrowserSiteGrants({
  snapshot,
  disabled,
  onRevoke,
}: {
  snapshot: BrowserSettingsSnapshot;
  disabled: boolean;
  onRevoke: (kind: BrowserSiteGrantKind, origin: string) => void;
}) {
  return (
    <BrowserSettingsGroup title="Exact-site grants">
      <GrantCard
        label="Agent website access"
        description="Exact origins the agent can open without another website prompt. Password use is never granted persistently."
        sites={snapshot.approvedAgentOrigins}
        emptyLabel="No websites are approved yet."
        kind="agent_navigation"
        disabled={disabled}
        onRevoke={onRevoke}
      />
      {PERMISSION_CARDS.map((card) => (
        <GrantCard
          key={`${card.kind}-${card.state}`}
          label={card.label}
          description={
            card.state === 'allow' && snapshot.permissionSummary[card.kind] === 'blocked'
              ? `${card.kind === 'camera' ? 'Camera' : 'Microphone'} is set to Block, so these remembered choices stay inactive until you switch back to Ask.`
              : card.description
          }
          sites={snapshot.sitePermissionRules
            .filter((rule) => rule[card.kind] === card.state)
            .map((rule) => rule.origin)}
          kind={card.kind}
          disabled={disabled}
          onRevoke={onRevoke}
        />
      ))}
    </BrowserSettingsGroup>
  );
}
