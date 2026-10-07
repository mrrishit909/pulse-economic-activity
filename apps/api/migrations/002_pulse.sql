-- PULSE domain tables (blueprint 04 section 5), with additions marked (+). PostGIS holds the geography. Shared synthetic data has
-- tenant_id NULL; rows a tenant uploads (private vessel events) and its alerts carry tenant_id and sit behind row-level security.
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE locations (
  id UUID PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,              -- (+) UN/LOCODE for ports, slug for regions
  name TEXT,
  location_type TEXT CHECK (location_type IN ('port', 'region')),
  country_code TEXT,
  region_code TEXT,                       -- (+) the port's region
  geom GEOGRAPHY(POINT, 4326)
);
CREATE INDEX locations_geom ON locations USING GIST (geom);

CREATE TABLE vessels (                    -- (+) the public register: IMO, name, class (MMSIs are learned, not registered)
  id UUID PRIMARY KEY, imo TEXT UNIQUE NOT NULL, name TEXT NOT NULL, vessel_class TEXT NOT NULL
);

CREATE TABLE trade_flows (
  id UUID PRIMARY KEY,
  origin_id UUID REFERENCES locations(id),
  destination_id UUID REFERENCES locations(id),
  commodity_code TEXT,
  ts DATE,
  quantity NUMERIC,                       -- kt departed that day on the lane
  value_usd NUMERIC,
  confidence DOUBLE PRECISION,            -- relative 90% half-width of the cargo estimate
  source TEXT,
  voyages INT                             -- (+)
);
CREATE INDEX trade_flows_commodity_ts ON trade_flows (commodity_code, ts);

CREATE TABLE vessel_events (
  id UUID PRIMARY KEY,
  tenant_id UUID REFERENCES organizations(id),   -- (+) NULL = shared feed; set = a tenant's private upload
  vessel_id TEXT,                                -- raw identifier as received (IMO or MMSI)
  port_id UUID REFERENCES locations(id),
  event_type TEXT CHECK (event_type IN ('arrival', 'departure')),
  ts TIMESTAMPTZ,
  draught DOUBLE PRECISION,
  metadata JSONB,                                -- raw name / port alias / position / source
  resolved_vessel UUID REFERENCES vessels(id),   -- (+) entity resolution result
  resolution TEXT                                -- (+) how it was resolved (imo, name-at-port, coincident-port-row, ...)
);
CREATE INDEX vessel_events_port_ts ON vessel_events (port_id, ts);
CREATE INDEX vessel_events_vessel ON vessel_events (resolved_vessel, ts);

CREATE TABLE regional_activity_index (
  region_id UUID REFERENCES locations(id),
  ts TIMESTAMPTZ,
  score DOUBLE PRECISION,
  components JSONB,                      -- per-series contributions, the 80% band and confidence
  model_version TEXT,
  PRIMARY KEY (region_id, ts)
);

CREATE TABLE port_activity (            -- (+) congestion from dwell distributions, one row per port and day
  port_id UUID REFERENCES locations(id), ts DATE, calls INT, dwell_median DOUBLE PRECISION, dwell_p90 DOUBLE PRECISION,
  in_port INT, congestion_z DOUBLE PRECISION, confidence TEXT, PRIMARY KEY (port_id, ts)
);
CREATE TABLE official_indicators (      -- (+) the lagging official series
  region_id UUID REFERENCES locations(id), month TEXT, value DOUBLE PRECISION, released_on DATE, PRIMARY KEY (region_id, month)
);
CREATE TABLE nowcasts (                 -- (+) rolling-origin nowcasts made at each month end
  region_id UUID REFERENCES locations(id), month TEXT, made_on DATE, bridge DOUBLE PRECISION, lo DOUBLE PRECISION, hi DOUBLE PRECISION,
  gbm DOUBLE PRECISION, naive DOUBLE PRECISION, actual DOUBLE PRECISION, PRIMARY KEY (region_id, month)
);
CREATE TABLE artifacts (name TEXT PRIMARY KEY, sha256 TEXT, body_gz BYTEA, created_at TIMESTAMPTZ DEFAULT now()); -- (+) the bundle

CREATE TABLE alert_rules (id UUID PRIMARY KEY, tenant_id UUID NOT NULL REFERENCES organizations(id), rule JSONB NOT NULL, created_by TEXT, updated_at TIMESTAMPTZ DEFAULT now(), deleted_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE alert_deliveries (id BIGSERIAL PRIMARY KEY, tenant_id UUID NOT NULL REFERENCES organizations(id), rule_id UUID REFERENCES alert_rules(id), day DATE, channel TEXT, target TEXT, text TEXT, status TEXT, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE client_telemetry (id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ DEFAULT now(), sample JSONB NOT NULL);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pulse_app') THEN CREATE ROLE pulse_app LOGIN PASSWORD 'app-dev-only'; END IF;
END $$;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO pulse_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO pulse_app;
REVOKE UPDATE, DELETE ON audit_log FROM pulse_app;
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['alert_rules', 'alert_deliveries', 'audit_log', 'idempotency_keys'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant'', true), '''')::uuid)', t);
  END LOOP;
END $$;
-- shared feed rows are visible to everyone; private uploads only to their tenant; writes only as yourself
ALTER TABLE vessel_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY shared_or_own ON vessel_events FOR SELECT USING (tenant_id IS NULL OR tenant_id = NULLIF(current_setting('app.tenant', true), '')::uuid);
CREATE POLICY insert_own ON vessel_events FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant', true), '')::uuid);
