CREATE TABLE channel_conversations (
 tenant_id TEXT NOT NULL,
 user_id TEXT NOT NULL,
 agent_id TEXT NOT NULL,
 session_id TEXT NOT NULL UNIQUE,
 mode TEXT NOT NULL DEFAULT 'work',
 transition_id TEXT,
 last_seq BIGINT NOT NULL DEFAULT -1,
 reply_channel TEXT NOT NULL,
 PRIMARY KEY (tenant_id,user_id,agent_id)
);
--> statement-breakpoint
-- Retired sessions still drain output, but never receive new inbound messages.
CREATE TABLE channel_conversation_drains (
 session_id TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL,
 user_id TEXT NOT NULL,
 agent_id TEXT NOT NULL,
 last_seq BIGINT NOT NULL DEFAULT -1
);
--> statement-breakpoint
CREATE TABLE channel_deliveries (
 id TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL,
 user_id TEXT NOT NULL,
 agent_id TEXT NOT NULL,
 session_id TEXT NOT NULL,
 event TEXT,
 text TEXT,
 reply_markup TEXT,
 delivered_chars BIGINT NOT NULL DEFAULT 0,
 sent INTEGER NOT NULL DEFAULT 0,
 attempts INTEGER NOT NULL DEFAULT 0,
 next_at BIGINT NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE channel_agent_lists (
 tenant_id TEXT NOT NULL,
 user_id TEXT NOT NULL,
 channel TEXT NOT NULL,
 agent_ids TEXT NOT NULL,
 PRIMARY KEY (tenant_id,user_id,channel)
);
--> statement-breakpoint
INSERT INTO channel_conversations (tenant_id,user_id,agent_id,session_id,mode,transition_id,last_seq,reply_channel)
 SELECT tenant_id,user_id,agent_id,session_id,mode,transition_id,last_seq,'telegram' FROM telegram_conversations;
--> statement-breakpoint
INSERT INTO channel_conversations (tenant_id,user_id,agent_id,session_id,mode,transition_id,last_seq,reply_channel)
 SELECT i.tenant_id,i.user_id,i.agent_id,i.session_id,i.mode,i.transition_id,i.last_seq,'imessage'
 FROM imessage_conversations i WHERE NOT EXISTS (
 SELECT 1 FROM telegram_conversations t WHERE t.tenant_id=i.tenant_id AND t.user_id=i.user_id AND t.agent_id=i.agent_id);
--> statement-breakpoint
INSERT INTO channel_conversation_drains (session_id,tenant_id,user_id,agent_id,last_seq)
 SELECT i.session_id,i.tenant_id,i.user_id,i.agent_id,i.last_seq FROM imessage_conversations i
 JOIN channel_conversations c ON c.tenant_id=i.tenant_id AND c.user_id=i.user_id AND c.agent_id=i.agent_id
 WHERE i.session_id<>c.session_id;
--> statement-breakpoint
-- If both channels tracked the SAME session, its cursor is the delivered union.
UPDATE channel_conversations SET last_seq=(SELECT MAX(i.last_seq) FROM imessage_conversations i WHERE i.session_id=channel_conversations.session_id)
 WHERE EXISTS (SELECT 1 FROM imessage_conversations i WHERE i.session_id=channel_conversations.session_id AND i.last_seq>channel_conversations.last_seq);
--> statement-breakpoint
INSERT INTO channel_deliveries (id,tenant_id,user_id,agent_id,session_id,text,reply_markup,attempts,next_at)
 SELECT 'legacy:telegram:' || o.id,o.tenant_id,o.user_id,c.agent_id,c.session_id,o.text,o.reply_markup,o.attempts,o.next_at
 FROM telegram_outbox o JOIN telegram_conversations c
 ON o.tenant_id=c.tenant_id AND o.user_id=c.user_id AND SUBSTR(o.id,1,LENGTH(c.session_id)+7)='event:' || c.session_id || ':'
 WHERE o.sent=0;
--> statement-breakpoint
UPDATE telegram_outbox SET sent=1,text='',reply_markup=NULL WHERE id IN
 (SELECT SUBSTR(id,17) FROM channel_deliveries WHERE id LIKE 'legacy:telegram:%');
--> statement-breakpoint
INSERT INTO channel_deliveries (id,tenant_id,user_id,agent_id,session_id,text,reply_markup,attempts,next_at)
 SELECT 'legacy:imessage:' || o.id,o.tenant_id,o.user_id,c.agent_id,c.session_id,o.text,o.reply_markup,o.attempts,o.next_at
 FROM imessage_outbox o JOIN imessage_conversations c
 ON o.tenant_id=c.tenant_id AND o.user_id=c.user_id AND SUBSTR(o.id,1,LENGTH(c.session_id)+7)='event:' || c.session_id || ':'
 WHERE o.sent=0;
--> statement-breakpoint
UPDATE imessage_outbox SET sent=1,text='',reply_markup=NULL WHERE id IN
 (SELECT SUBSTR(id,17) FROM channel_deliveries WHERE id LIKE 'legacy:imessage:%');
--> statement-breakpoint
-- A pre-upgrade /run may already have replaced the binding while output remained queued.
INSERT INTO channel_conversation_drains (session_id,tenant_id,user_id,agent_id,last_seq)
 SELECT s.id,o.tenant_id,o.user_id,s.agent_id,MAX(CAST(SUBSTR(o.id,LENGTH(s.id)+8,16) AS BIGINT))
 FROM telegram_outbox o JOIN sessions s ON s.tenant_id=o.tenant_id
 AND SUBSTR(o.id,1,LENGTH(s.id)+7)='event:' || s.id || ':'
 JOIN channel_conversations c ON c.tenant_id=o.tenant_id AND c.user_id=o.user_id AND c.agent_id=s.agent_id
 WHERE s.id<>c.session_id AND NOT EXISTS (SELECT 1 FROM channel_conversation_drains d WHERE d.session_id=s.id)
 GROUP BY s.id,o.tenant_id,o.user_id,s.agent_id;
--> statement-breakpoint
INSERT INTO channel_deliveries (id,tenant_id,user_id,agent_id,session_id,text,reply_markup,attempts,next_at)
 SELECT 'legacy:telegram:' || o.id,o.tenant_id,o.user_id,d.agent_id,d.session_id,o.text,o.reply_markup,o.attempts,o.next_at
 FROM telegram_outbox o JOIN channel_conversation_drains d
 ON d.tenant_id=o.tenant_id AND d.user_id=o.user_id
 AND SUBSTR(o.id,1,LENGTH(d.session_id)+7)='event:' || d.session_id || ':'
 WHERE o.sent=0 ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
UPDATE telegram_outbox SET sent=1,text='',reply_markup=NULL WHERE id IN
 (SELECT SUBSTR(id,17) FROM channel_deliveries WHERE id LIKE 'legacy:telegram:%');
--> statement-breakpoint
-- A pre-upgrade /run may already have replaced the binding while output remained queued.
INSERT INTO channel_conversation_drains (session_id,tenant_id,user_id,agent_id,last_seq)
 SELECT s.id,o.tenant_id,o.user_id,s.agent_id,MAX(CAST(SUBSTR(o.id,LENGTH(s.id)+8,16) AS BIGINT))
 FROM imessage_outbox o JOIN sessions s ON s.tenant_id=o.tenant_id
 AND SUBSTR(o.id,1,LENGTH(s.id)+7)='event:' || s.id || ':'
 JOIN channel_conversations c ON c.tenant_id=o.tenant_id AND c.user_id=o.user_id AND c.agent_id=s.agent_id
 WHERE s.id<>c.session_id AND NOT EXISTS (SELECT 1 FROM channel_conversation_drains d WHERE d.session_id=s.id)
 GROUP BY s.id,o.tenant_id,o.user_id,s.agent_id;
--> statement-breakpoint
INSERT INTO channel_deliveries (id,tenant_id,user_id,agent_id,session_id,text,reply_markup,attempts,next_at)
 SELECT 'legacy:imessage:' || o.id,o.tenant_id,o.user_id,d.agent_id,d.session_id,o.text,o.reply_markup,o.attempts,o.next_at
 FROM imessage_outbox o JOIN channel_conversation_drains d
 ON d.tenant_id=o.tenant_id AND d.user_id=o.user_id
 AND SUBSTR(o.id,1,LENGTH(d.session_id)+7)='event:' || d.session_id || ':'
 WHERE o.sent=0 ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
UPDATE imessage_outbox SET sent=1,text='',reply_markup=NULL WHERE id IN
 (SELECT SUBSTR(id,17) FROM channel_deliveries WHERE id LIKE 'legacy:imessage:%');
