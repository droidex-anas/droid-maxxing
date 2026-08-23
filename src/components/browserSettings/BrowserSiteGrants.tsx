import type { BrowserSettingsSnapshot, BrowserSiteGrantKind } from '../../lib/browserSettings';
import {
  BrowserSettingsCard,
  BrowserSettingsGroup,
  ExactSiteList,
} from './BrowserSettingsPrimitives';

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
  emptyLabel: string;
  kind: BrowserSiteGrantKind;
  disabled: boolean;
  onRevoke: (kind: BrowserSiteGrantKind, origin: string) => void;
}) {
  return (
    <BrowserSettingsCard>
      <div className="border-b border-droid-border/50 px-4 py-3">
        <div className="text-[12.5px] text-droid-text">{label}</div>
        <p className="mt-0.5 text-[11px] leading-4 text-droid-text-muted">{description}</p>
      </div>
      <ExactSiteList
        emptyLabel={emptyLabel}
        sites={sites}
        disabled={disabled}
        onRevoke={(origin) => {
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
  const cameraAllowed = snapshot.sitePermissionRules
    .filter((rule) => rule.camera === 'allow')
    .map((rule) => rule.origin);
  const cameraBlocked = snapshot.sitePermissionRules
    .filter((rule) => rule.camera === 'deny')
    .map((rule) => rule.origin);
  const microphoneAllowed = snapshot.sitePermissionRules
    .filter((rule) => rule.microphone === 'allow')
    .map((rule) => rule.origin);
  const microphoneBlocked = snapshot.sitePermissionRules
    .filter((rule) => rule.microphone === 'deny')
    .map((rule) => rule.origin);
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
      {microphoneAllowed.length > 0 && (
        <GrantCard
          label="Allowed microphone"
          description="Remembered exact-site choices that can use the microphone without another DROIDEX prompt."
          sites={microphoneAllowed}
          emptyLabel="No microphone sites are allowed."
          kind="microphone"
          disabled={disabled}
          onRevoke={onRevoke}
        />
      )}
      {microphoneBlocked.length > 0 && (
        <GrantCard
          label="Blocked microphone"
          description="Remembered exact-site choices that cannot use the microphone."
          sites={microphoneBlocked}
          emptyLabel="No microphone sites are blocked."
          kind="microphone"
          disabled={disabled}
          onRevoke={onRevoke}
        />
      )}
      {cameraAllowed.length > 0 && (
        <GrantCard
          label="Allowed camera"
          description="Remembered exact-site choices that can use the camera without another DROIDEX prompt."
          sites={cameraAllowed}
          emptyLabel="No camera sites are allowed."
          kind="camera"
          disabled={disabled}
          onRevoke={onRevoke}
        />
      )}
      {cameraBlocked.length > 0 && (
        <GrantCard
          label="Blocked camera"
          description="Remembered exact-site choices that cannot use the camera."
          sites={cameraBlocked}
          emptyLabel="No camera sites are blocked."
          kind="camera"
          disabled={disabled}
          onRevoke={onRevoke}
        />
      )}
    </BrowserSettingsGroup>
  );
}
