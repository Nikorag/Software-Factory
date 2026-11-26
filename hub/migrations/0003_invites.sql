-- Invitations: an existing user mints a single-use, expiring token that lets one new person register a passkey.
-- Only a hash of the token is stored (it is shown once). An invited user gets their own organisation, so they only
-- ever see their own factories; an invite grants no access to the inviter's.
CREATE TABLE invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  used_by uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invites_creator_idx ON invites (created_by);

ALTER TABLE webauthn_challenges DROP CONSTRAINT webauthn_challenges_purpose_check;
ALTER TABLE webauthn_challenges ADD CONSTRAINT webauthn_challenges_purpose_check CHECK (purpose IN ('setup','login','add-passkey','invite'));
