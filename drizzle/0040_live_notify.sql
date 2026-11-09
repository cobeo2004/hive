-- Live updates (R31): every write to a followed table tells LISTEN hive_changes which table changed, once per statement.
CREATE FUNCTION "hive_notify"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('hive_changes', TG_TABLE_NAME);
  RETURN NULL;
END
$$;--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['jobs', 'runs', 'agents', 'events', 'intents', 'machines', 'job_evidence', 'audit_log'] LOOP
    EXECUTE format('CREATE TRIGGER "hive_notify" AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION "hive_notify"()', t);
  END LOOP;
END
$$;
