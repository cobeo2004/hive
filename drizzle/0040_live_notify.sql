-- Live updates (R31): every write to a followed table tells LISTEN hive_changes which table changed, once per
-- statement, and only when the statement changed rows. A zero-row UPDATE (the runner's closeBroadcast on a
-- broadcast still waiting for receipts) would otherwise wake the runner into the same UPDATE again.
CREATE FUNCTION "hive_notify"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM changed) THEN
    PERFORM pg_notify('hive_changes', TG_TABLE_NAME);
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['jobs', 'runs', 'agents', 'events', 'intents', 'machines', 'job_evidence', 'audit_log'] LOOP
    -- A transition table belongs to one event, so each event gets its own trigger.
    EXECUTE format('CREATE TRIGGER "hive_notify_insert" AFTER INSERT ON %I REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION "hive_notify"()', t);
    EXECUTE format('CREATE TRIGGER "hive_notify_update" AFTER UPDATE ON %I REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION "hive_notify"()', t);
    EXECUTE format('CREATE TRIGGER "hive_notify_delete" AFTER DELETE ON %I REFERENCING OLD TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION "hive_notify"()', t);
  END LOOP;
END
$$;
