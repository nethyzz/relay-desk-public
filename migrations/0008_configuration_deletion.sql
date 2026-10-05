-- Keep historical reports and their snapshots while removing live configuration.
ALTER TABLE endpoints ADD COLUMN deleted_at INTEGER;
ALTER TABLE targets ADD COLUMN deleted_at INTEGER;
CREATE INDEX live_endpoints_by_url ON endpoints(base_url) WHERE deleted_at IS NULL;
CREATE INDEX live_targets_by_endpoint ON targets(endpoint_id) WHERE deleted_at IS NULL;

CREATE TRIGGER deleted_key_cannot_be_reused BEFORE UPDATE ON endpoints
WHEN OLD.deleted_at IS NOT NULL AND (NEW.deleted_at IS NULL OR NEW.key_cipher != '' OR NEW.base_url != OLD.base_url OR NEW.name != OLD.name OR NEW.station_name != OLD.station_name)
BEGIN SELECT RAISE(ABORT, 'configuration_deleted'); END;
CREATE TRIGGER deleted_key_cannot_receive_models BEFORE INSERT ON targets
WHEN EXISTS(SELECT 1 FROM endpoints WHERE id=NEW.endpoint_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'configuration_deleted'); END;
CREATE TRIGGER deleted_model_cannot_be_edited BEFORE UPDATE ON targets
WHEN OLD.deleted_at IS NOT NULL OR (NEW.deleted_at IS NULL AND EXISTS(SELECT 1 FROM endpoints WHERE id=NEW.endpoint_id AND deleted_at IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'configuration_deleted'); END;
CREATE TRIGGER deleting_model_requires_finished_runs BEFORE UPDATE OF deleted_at ON targets
WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL AND EXISTS(SELECT 1 FROM runs WHERE target_id=OLD.id AND status IN ('queued','running'))
BEGIN SELECT RAISE(ABORT, 'configuration_in_use'); END;
CREATE TRIGGER deleting_key_requires_deleted_models BEFORE UPDATE OF deleted_at ON endpoints
WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL AND EXISTS(SELECT 1 FROM targets WHERE endpoint_id=OLD.id AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'configuration_changed'); END;
CREATE TRIGGER deleted_model_cannot_start_runs BEFORE INSERT ON runs
WHEN EXISTS(SELECT 1 FROM targets t JOIN endpoints e ON e.id=t.endpoint_id WHERE t.id=NEW.target_id AND (t.deleted_at IS NOT NULL OR e.deleted_at IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'configuration_deleted'); END;
CREATE TRIGGER deleted_model_cannot_join_presets BEFORE INSERT ON run_preset_targets
WHEN EXISTS(SELECT 1 FROM targets WHERE id=NEW.target_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'configuration_deleted'); END;
CREATE TRIGGER deleted_model_cannot_add_schedule BEFORE INSERT ON schedules
WHEN EXISTS(SELECT 1 FROM targets WHERE id=NEW.target_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'configuration_deleted'); END;
CREATE TRIGGER deleted_model_cannot_enable_schedule BEFORE UPDATE ON schedules
WHEN NEW.enabled=1 AND EXISTS(SELECT 1 FROM targets WHERE id=NEW.target_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'configuration_deleted'); END;
