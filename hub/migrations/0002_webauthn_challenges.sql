-- Short-lived, single-use WebAuthn challenges. In PostgreSQL (not Redis or memory) so a ceremony can
-- start on one replica and finish on another, and survive a Redis flush.
CREATE TABLE webauthn_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose text NOT NULL CHECK (purpose IN ('setup','login','add-passkey')),
  challenge text NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  data jsonb NOT NULL DEFAULT '{}',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webauthn_challenges_expiry_idx ON webauthn_challenges (expires_at);
