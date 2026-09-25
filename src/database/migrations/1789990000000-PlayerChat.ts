import type { MigrationInterface, QueryRunner } from 'typeorm';
export class PlayerChat1789990000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE player_chat_direct_threads (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        game_server_id uuid NOT NULL,
        participant_a_player_character_id uuid NOT NULL,
        participant_b_player_character_id uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT player_chat_direct_threads_server_fkey FOREIGN KEY (game_server_id) REFERENCES game_servers(id),
        CONSTRAINT player_chat_direct_threads_a_fkey FOREIGN KEY (participant_a_player_character_id) REFERENCES player_characters(id),
        CONSTRAINT player_chat_direct_threads_b_fkey FOREIGN KEY (participant_b_player_character_id) REFERENCES player_characters(id),
        CONSTRAINT player_chat_direct_threads_pair_key UNIQUE (participant_a_player_character_id, participant_b_player_character_id),
        CONSTRAINT player_chat_direct_threads_pair_check CHECK (participant_a_player_character_id < participant_b_player_character_id)
      );
      CREATE TABLE player_chat_messages (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        game_server_id uuid NOT NULL,
        channel_type varchar(16) NOT NULL,
        sender_character_id varchar(128) NOT NULL,
        sender_player_character_id uuid,
        group_id uuid,
        guild_id uuid,
        direct_thread_id uuid,
        content text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        CONSTRAINT player_chat_messages_server_fkey FOREIGN KEY (game_server_id) REFERENCES game_servers(id),
        CONSTRAINT player_chat_messages_sender_fkey FOREIGN KEY (sender_player_character_id) REFERENCES player_characters(id),
        CONSTRAINT player_chat_messages_group_fkey FOREIGN KEY (group_id) REFERENCES player_groups(id),
        CONSTRAINT player_chat_messages_guild_fkey FOREIGN KEY (guild_id) REFERENCES player_guilds(id),
        CONSTRAINT player_chat_messages_thread_fkey FOREIGN KEY (direct_thread_id) REFERENCES player_chat_direct_threads(id),
        CONSTRAINT player_chat_messages_channel_check CHECK (
          (channel_type = 'GLOBAL' AND group_id IS NULL AND guild_id IS NULL AND direct_thread_id IS NULL)
          OR (channel_type = 'GROUP' AND group_id IS NOT NULL AND guild_id IS NULL AND direct_thread_id IS NULL)
          OR (channel_type = 'GUILD' AND guild_id IS NOT NULL AND group_id IS NULL AND direct_thread_id IS NULL)
          OR (channel_type = 'DIRECT' AND direct_thread_id IS NOT NULL AND sender_player_character_id IS NOT NULL AND group_id IS NULL AND guild_id IS NULL)),
        CONSTRAINT player_chat_messages_content_check CHECK (char_length(content) BETWEEN 1 AND 500 AND content = btrim(content) AND content !~ '[[:cntrl:]]' AND length(btrim(sender_character_id)) > 0),
        CONSTRAINT player_chat_messages_expiry_check CHECK (expires_at > created_at)
      );
      CREATE INDEX player_chat_messages_global_idx ON player_chat_messages(game_server_id, created_at, id) WHERE channel_type = 'GLOBAL';
      CREATE INDEX player_chat_messages_group_idx ON player_chat_messages(group_id, created_at, id) WHERE group_id IS NOT NULL;
      CREATE INDEX player_chat_messages_guild_idx ON player_chat_messages(guild_id, created_at, id) WHERE guild_id IS NOT NULL;
      CREATE INDEX player_chat_messages_direct_idx ON player_chat_messages(direct_thread_id, created_at, id) WHERE direct_thread_id IS NOT NULL;
      CREATE INDEX player_chat_messages_expiry_idx ON player_chat_messages(expires_at);
      CREATE TABLE player_chat_requests (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        idempotency_scope varchar(64) NOT NULL,
        idempotency_key varchar(128) NOT NULL,
        player_id uuid NOT NULL,
        request_fingerprint char(64) NOT NULL,
        message_id uuid NOT NULL,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT player_chat_requests_player_fkey FOREIGN KEY (player_id) REFERENCES players(id),
        CONSTRAINT player_chat_requests_message_fkey FOREIGN KEY (message_id) REFERENCES player_chat_messages(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
        CONSTRAINT player_chat_requests_idempotency_key UNIQUE (idempotency_scope, idempotency_key),
        CONSTRAINT player_chat_requests_scope_check CHECK (idempotency_scope = ('PLAYER:' || player_id::text) AND length(idempotency_key) > 0)
      );

      -- Both participants are ownership links of the thread's server.
      CREATE FUNCTION guard_player_chat_direct_thread() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          RAISE EXCEPTION 'chat threads are immutable' USING ERRCODE = '55000';
        END IF;
        IF (SELECT count(*) FROM player_characters
             WHERE id IN (NEW.participant_a_player_character_id, NEW.participant_b_player_character_id)
               AND game_server_id = NEW.game_server_id) <> 2 THEN
          RAISE EXCEPTION 'chat thread participants must belong to its server' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER player_chat_direct_threads_guard
        BEFORE INSERT OR UPDATE ON player_chat_direct_threads
        FOR EACH ROW EXECUTE FUNCTION guard_player_chat_direct_thread();
      -- The sender link is the sender character on the message's server, and
      -- the group, guild or thread belongs to that server (a DIRECT sender is
      -- one of the thread's participants).
      CREATE FUNCTION guard_player_chat_message_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.sender_player_character_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM player_characters WHERE id = NEW.sender_player_character_id
             AND game_server_id = NEW.game_server_id AND character_external_id = NEW.sender_character_id) THEN
          RAISE EXCEPTION 'chat sender does not match its link' USING ERRCODE = '23514';
        END IF;
        IF (NEW.group_id IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM player_groups WHERE id = NEW.group_id AND game_server_id = NEW.game_server_id))
          OR (NEW.guild_id IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM player_guilds WHERE id = NEW.guild_id AND game_server_id = NEW.game_server_id))
          OR (NEW.direct_thread_id IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM player_chat_direct_threads WHERE id = NEW.direct_thread_id AND game_server_id = NEW.game_server_id
                 AND NEW.sender_player_character_id IN (participant_a_player_character_id, participant_b_player_character_id))) THEN
          RAISE EXCEPTION 'chat channel does not match the message server' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER player_chat_messages_insert_guard
        BEFORE INSERT ON player_chat_messages
        FOR EACH ROW EXECUTE FUNCTION guard_player_chat_message_insert();
      -- Messages and their idempotency records are never edited. A row may
      -- only be deleted once expired: the future retention purge (Etapa 12)
      -- stays possible, removing a live message is not. Moderation or
      -- redaction, if added, gets its own audited, migrated path.
      CREATE FUNCTION guard_player_chat_history() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
        END IF;
        IF OLD.expires_at > now() THEN
          RAISE EXCEPTION '% rows can only be purged after expiry', TG_TABLE_NAME USING ERRCODE = '55000';
        END IF;
        RETURN OLD;
      END;
      $$;
      CREATE TRIGGER player_chat_messages_guard
        BEFORE UPDATE OR DELETE ON player_chat_messages
        FOR EACH ROW EXECUTE FUNCTION guard_player_chat_history();
      CREATE TRIGGER player_chat_requests_guard
        BEFORE UPDATE OR DELETE ON player_chat_requests
        FOR EACH ROW EXECUTE FUNCTION guard_player_chat_history();
      CREATE FUNCTION reject_player_chat_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION '% cannot be truncated', TG_TABLE_NAME USING ERRCODE = '55000';
      END;
      $$;
      CREATE TRIGGER player_chat_messages_truncate
        BEFORE TRUNCATE ON player_chat_messages
        FOR EACH STATEMENT EXECUTE FUNCTION reject_player_chat_truncate();
      CREATE TRIGGER player_chat_requests_truncate
        BEFORE TRUNCATE ON player_chat_requests
        FOR EACH STATEMENT EXECUTE FUNCTION reject_player_chat_truncate();
      CREATE TRIGGER player_chat_direct_threads_truncate
        BEFORE TRUNCATE ON player_chat_direct_threads
        FOR EACH STATEMENT EXECUTE FUNCTION reject_player_chat_truncate();
    `);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    // Refuse to erase private conversations still within retention or not.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM player_chat_messages) OR EXISTS (SELECT 1 FROM player_chat_direct_threads) THEN
          RAISE EXCEPTION 'chat messages exist; refusing to drop them' USING ERRCODE = '55000';
        END IF;
      END;
      $$;
      DROP TABLE player_chat_requests;
      DROP TABLE player_chat_messages;
      DROP TABLE player_chat_direct_threads;
      DROP FUNCTION reject_player_chat_truncate();
      DROP FUNCTION guard_player_chat_history();
      DROP FUNCTION guard_player_chat_message_insert();
      DROP FUNCTION guard_player_chat_direct_thread();
    `);
  }
}
