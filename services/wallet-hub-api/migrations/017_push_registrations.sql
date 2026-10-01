-- Durable device registrations for receive push notifications.
--
-- A token identifies one FCM installation globally. It may move between users
-- or apps when a device is handed off, while distinct tokens allow each user
-- to register any number of devices.
CREATE TABLE IF NOT EXISTS push_device_registrations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id      UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fcm_token   TEXT NOT NULL UNIQUE CHECK (length(fcm_token) BETWEEN 1 AND 4096),
  platform    TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS push_device_registrations_app_user_idx
  ON push_device_registrations (app_id, user_id);

-- Address rows are normalized so one device can watch an arbitrary address
-- set. watch_started_at is retained when an address survives a full-set
-- replacement; newly-added addresses begin watching at insertion time.
CREATE TABLE IF NOT EXISTS push_registration_addresses (
  registration_id UUID NOT NULL
    REFERENCES push_device_registrations(id) ON DELETE CASCADE,
  chain            TEXT NOT NULL CHECK (chain IN ('arch', 'btc')),
  address          TEXT NOT NULL,
  watch_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (registration_id, chain, address)
);

CREATE INDEX IF NOT EXISTS push_registration_addresses_lookup_idx
  ON push_registration_addresses (chain, address, watch_started_at);
