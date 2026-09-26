/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source of truth: supabase/migrations/*.sql
 * Regenerate:     pnpm -F @suite/poster-service gen:types
 *                 (requires a running local stack: pnpm exec supabase start)
 *
 * Only the `poster` schema is generated. The service reads and writes Postgres
 * directly as service_role through postgres.js (D-019), so these types exist to
 * keep query results honest — they are not a PostgREST client surface, and no
 * browser ever sees them (D-024).
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  poster: {
    Tables: {
      account_settings: {
        Row: {
          created_at: string;
          posting_suspended_at: string | null;
          suspension_reason: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          posting_suspended_at?: string | null;
          suspension_reason?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          posting_suspended_at?: string | null;
          suspension_reason?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      client_apps: {
        Row: {
          client_id: string;
          client_secret_hash: string;
          created_at: string;
          disabled_at: string | null;
          first_party: boolean;
          id: string;
          name: string;
          rate_limit_per_min: number;
          webhook_secret_ref: string | null;
          webhook_url: string | null;
        };
        Insert: {
          client_id: string;
          client_secret_hash: string;
          created_at?: string;
          disabled_at?: string | null;
          first_party?: boolean;
          id?: string;
          name: string;
          rate_limit_per_min?: number;
          webhook_secret_ref?: string | null;
          webhook_url?: string | null;
        };
        Update: {
          client_id?: string;
          client_secret_hash?: string;
          created_at?: string;
          disabled_at?: string | null;
          first_party?: boolean;
          id?: string;
          name?: string;
          rate_limit_per_min?: number;
          webhook_secret_ref?: string | null;
          webhook_url?: string | null;
        };
        Relationships: [];
      };
      connections: {
        Row: {
          avatar_url: string | null;
          created_at: string;
          credential_id: string;
          disconnected_at: string | null;
          display_name: string | null;
          external_account_id: string;
          handle: string | null;
          id: string;
          last_checked_at: string | null;
          platform_id: string;
          refresh_failures: number;
          status: Database['poster']['Enums']['connection_status'];
          status_reason: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          avatar_url?: string | null;
          created_at?: string;
          credential_id: string;
          disconnected_at?: string | null;
          display_name?: string | null;
          external_account_id: string;
          handle?: string | null;
          id?: string;
          last_checked_at?: string | null;
          platform_id: string;
          refresh_failures?: number;
          status?: Database['poster']['Enums']['connection_status'];
          status_reason?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          avatar_url?: string | null;
          created_at?: string;
          credential_id?: string;
          disconnected_at?: string | null;
          display_name?: string | null;
          external_account_id?: string;
          handle?: string | null;
          id?: string;
          last_checked_at?: string | null;
          platform_id?: string;
          refresh_failures?: number;
          status?: Database['poster']['Enums']['connection_status'];
          status_reason?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'connections_credential_id_user_id_fkey';
            columns: ['credential_id', 'user_id'];
            isOneToOne: false;
            referencedRelation: 'credentials';
            referencedColumns: ['id', 'user_id'];
          },
          {
            foreignKeyName: 'connections_platform_id_fkey';
            columns: ['platform_id'];
            isOneToOne: false;
            referencedRelation: 'platforms';
            referencedColumns: ['id'];
          },
        ];
      };
      credentials: {
        Row: {
          ciphertext: string;
          created_at: string;
          expires_at: string | null;
          id: string;
          kind: Database['poster']['Enums']['credential_kind'];
          kms_key_id: string;
          nonce: string;
          provider: string;
          updated_at: string;
          user_id: string;
          wrapped_dek: string;
        };
        Insert: {
          ciphertext: string;
          created_at?: string;
          expires_at?: string | null;
          id?: string;
          kind: Database['poster']['Enums']['credential_kind'];
          kms_key_id: string;
          nonce: string;
          provider: string;
          updated_at?: string;
          user_id: string;
          wrapped_dek: string;
        };
        Update: {
          ciphertext?: string;
          created_at?: string;
          expires_at?: string | null;
          id?: string;
          kind?: Database['poster']['Enums']['credential_kind'];
          kms_key_id?: string;
          nonce?: string;
          provider?: string;
          updated_at?: string;
          user_id?: string;
          wrapped_dek?: string;
        };
        Relationships: [];
      };
      dispatch_attempts: {
        Row: {
          adapter: string;
          attempt_no: number;
          finished_at: string | null;
          http_status: number | null;
          id: string;
          outcome: Database['poster']['Enums']['attempt_outcome'];
          request: Json | null;
          response: Json | null;
          started_at: string;
          target_id: string;
          worker_id: string;
        };
        Insert: {
          adapter: string;
          attempt_no: number;
          finished_at?: string | null;
          http_status?: number | null;
          id?: string;
          outcome?: Database['poster']['Enums']['attempt_outcome'];
          request?: Json | null;
          response?: Json | null;
          started_at?: string;
          target_id: string;
          worker_id: string;
        };
        Update: {
          adapter?: string;
          attempt_no?: number;
          finished_at?: string | null;
          http_status?: number | null;
          id?: string;
          outcome?: Database['poster']['Enums']['attempt_outcome'];
          request?: Json | null;
          response?: Json | null;
          started_at?: string;
          target_id?: string;
          worker_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'dispatch_attempts_target_id_fkey';
            columns: ['target_id'];
            isOneToOne: false;
            referencedRelation: 'post_targets';
            referencedColumns: ['id'];
          },
        ];
      };
      grants: {
        Row: {
          app_id: string;
          connection_id: string;
          granted_at: string;
          id: string;
          revoked_at: string | null;
          scope_request_id: string | null;
          scopes: string[];
          user_id: string;
        };
        Insert: {
          app_id: string;
          connection_id: string;
          granted_at?: string;
          id?: string;
          revoked_at?: string | null;
          scope_request_id?: string | null;
          scopes: string[];
          user_id: string;
        };
        Update: {
          app_id?: string;
          connection_id?: string;
          granted_at?: string;
          id?: string;
          revoked_at?: string | null;
          scope_request_id?: string | null;
          scopes?: string[];
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'grants_app_id_fkey';
            columns: ['app_id'];
            isOneToOne: false;
            referencedRelation: 'client_apps';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'grants_connection_id_user_id_fkey';
            columns: ['connection_id', 'user_id'];
            isOneToOne: false;
            referencedRelation: 'connections';
            referencedColumns: ['id', 'user_id'];
          },
          {
            foreignKeyName: 'grants_scope_request_id_fkey';
            columns: ['scope_request_id'];
            isOneToOne: false;
            referencedRelation: 'scope_requests';
            referencedColumns: ['id'];
          },
        ];
      };
      idempotency_keys: {
        Row: {
          app_id: string;
          created_at: string;
          expires_at: string;
          key: string;
          post_id: string | null;
          request_hash: string;
          response_body: Json | null;
          response_status: number | null;
        };
        Insert: {
          app_id: string;
          created_at?: string;
          expires_at?: string;
          key: string;
          post_id?: string | null;
          request_hash: string;
          response_body?: Json | null;
          response_status?: number | null;
        };
        Update: {
          app_id?: string;
          created_at?: string;
          expires_at?: string;
          key?: string;
          post_id?: string | null;
          request_hash?: string;
          response_body?: Json | null;
          response_status?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: 'idempotency_keys_app_id_fkey';
            columns: ['app_id'];
            isOneToOne: false;
            referencedRelation: 'client_apps';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'idempotency_keys_post_id_fkey';
            columns: ['post_id'];
            isOneToOne: false;
            referencedRelation: 'post_status';
            referencedColumns: ['post_id'];
          },
          {
            foreignKeyName: 'idempotency_keys_post_id_fkey';
            columns: ['post_id'];
            isOneToOne: false;
            referencedRelation: 'posts';
            referencedColumns: ['id'];
          },
        ];
      };
      media: {
        Row: {
          app_id: string;
          created_at: string;
          duration_ms: number | null;
          height: number | null;
          id: string;
          kind: Database['poster']['Enums']['media_kind'];
          mime_type: string;
          sha256: string | null;
          size_bytes: number | null;
          status: Database['poster']['Enums']['media_status'];
          storage_path: string;
          updated_at: string;
          user_id: string;
          width: number | null;
        };
        Insert: {
          app_id: string;
          created_at?: string;
          duration_ms?: number | null;
          height?: number | null;
          id?: string;
          kind: Database['poster']['Enums']['media_kind'];
          mime_type: string;
          sha256?: string | null;
          size_bytes?: number | null;
          status?: Database['poster']['Enums']['media_status'];
          storage_path: string;
          updated_at?: string;
          user_id: string;
          width?: number | null;
        };
        Update: {
          app_id?: string;
          created_at?: string;
          duration_ms?: number | null;
          height?: number | null;
          id?: string;
          kind?: Database['poster']['Enums']['media_kind'];
          mime_type?: string;
          sha256?: string | null;
          size_bytes?: number | null;
          status?: Database['poster']['Enums']['media_status'];
          storage_path?: string;
          updated_at?: string;
          user_id?: string;
          width?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: 'media_app_id_fkey';
            columns: ['app_id'];
            isOneToOne: false;
            referencedRelation: 'client_apps';
            referencedColumns: ['id'];
          },
        ];
      };
      media_renditions: {
        Row: {
          created_at: string;
          error: string | null;
          id: string;
          media_id: string;
          platform_id: string;
          spec_hash: string;
          status: Database['poster']['Enums']['rendition_status'];
          storage_path: string | null;
        };
        Insert: {
          created_at?: string;
          error?: string | null;
          id?: string;
          media_id: string;
          platform_id: string;
          spec_hash: string;
          status?: Database['poster']['Enums']['rendition_status'];
          storage_path?: string | null;
        };
        Update: {
          created_at?: string;
          error?: string | null;
          id?: string;
          media_id?: string;
          platform_id?: string;
          spec_hash?: string;
          status?: Database['poster']['Enums']['rendition_status'];
          storage_path?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'media_renditions_media_id_fkey';
            columns: ['media_id'];
            isOneToOne: false;
            referencedRelation: 'media';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'media_renditions_platform_id_fkey';
            columns: ['platform_id'];
            isOneToOne: false;
            referencedRelation: 'platforms';
            referencedColumns: ['id'];
          },
        ];
      };
      platform_constraints: {
        Row: {
          platform_id: string;
          spec: NonNullable<Json>;
          spec_version: number;
          updated_at: string;
        };
        Insert: {
          platform_id: string;
          spec: NonNullable<Json>;
          spec_version?: number;
          updated_at?: string;
        };
        Update: {
          platform_id?: string;
          spec?: NonNullable<Json>;
          spec_version?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'platform_constraints_platform_id_fkey';
            columns: ['platform_id'];
            isOneToOne: true;
            referencedRelation: 'platforms';
            referencedColumns: ['id'];
          },
        ];
      };
      platforms: {
        Row: {
          created_at: string;
          display_name: string;
          enabled: boolean;
          id: string;
          supports_threads: boolean;
        };
        Insert: {
          created_at?: string;
          display_name: string;
          enabled?: boolean;
          id: string;
          supports_threads?: boolean;
        };
        Update: {
          created_at?: string;
          display_name?: string;
          enabled?: boolean;
          id?: string;
          supports_threads?: boolean;
        };
        Relationships: [];
      };
      post_media: {
        Row: {
          media_id: string;
          part: number;
          position: number;
          post_id: string;
          user_id: string;
        };
        Insert: {
          media_id: string;
          part?: number;
          position: number;
          post_id: string;
          user_id: string;
        };
        Update: {
          media_id?: string;
          part?: number;
          position?: number;
          post_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'post_media_media_id_user_id_fkey';
            columns: ['media_id', 'user_id'];
            isOneToOne: false;
            referencedRelation: 'media';
            referencedColumns: ['id', 'user_id'];
          },
          {
            foreignKeyName: 'post_media_post_id_user_id_fkey';
            columns: ['post_id', 'user_id'];
            isOneToOne: false;
            referencedRelation: 'post_status';
            referencedColumns: ['post_id', 'user_id'];
          },
          {
            foreignKeyName: 'post_media_post_id_user_id_fkey';
            columns: ['post_id', 'user_id'];
            isOneToOne: false;
            referencedRelation: 'posts';
            referencedColumns: ['id', 'user_id'];
          },
        ];
      };
      post_targets: {
        Row: {
          attempt_count: number;
          claim_expires_at: string | null;
          claimed_by: string | null;
          connection_id: string;
          created_at: string;
          due_at: string;
          id: string;
          max_attempts: number;
          needs_reconciliation: boolean;
          next_attempt_at: string | null;
          overrides: NonNullable<Json>;
          paused_at: string | null;
          permalink: string | null;
          platform_id: string;
          platform_message: string | null;
          platform_post_id: string | null;
          position: number;
          post_id: string;
          posted_at: string | null;
          reason_class: Database['poster']['Enums']['reason_class'] | null;
          state: Database['poster']['Enums']['target_state'];
          updated_at: string;
          user_id: string;
        };
        Insert: {
          attempt_count?: number;
          claim_expires_at?: string | null;
          claimed_by?: string | null;
          connection_id: string;
          created_at?: string;
          due_at: string;
          id?: string;
          max_attempts?: number;
          needs_reconciliation?: boolean;
          next_attempt_at?: string | null;
          overrides?: NonNullable<Json>;
          paused_at?: string | null;
          permalink?: string | null;
          platform_id: string;
          platform_message?: string | null;
          platform_post_id?: string | null;
          position: number;
          post_id: string;
          posted_at?: string | null;
          reason_class?: Database['poster']['Enums']['reason_class'] | null;
          state?: Database['poster']['Enums']['target_state'];
          updated_at?: string;
          user_id: string;
        };
        Update: {
          attempt_count?: number;
          claim_expires_at?: string | null;
          claimed_by?: string | null;
          connection_id?: string;
          created_at?: string;
          due_at?: string;
          id?: string;
          max_attempts?: number;
          needs_reconciliation?: boolean;
          next_attempt_at?: string | null;
          overrides?: NonNullable<Json>;
          paused_at?: string | null;
          permalink?: string | null;
          platform_id?: string;
          platform_message?: string | null;
          platform_post_id?: string | null;
          position?: number;
          post_id?: string;
          posted_at?: string | null;
          reason_class?: Database['poster']['Enums']['reason_class'] | null;
          state?: Database['poster']['Enums']['target_state'];
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'post_targets_connection_id_user_id_platform_id_fkey';
            columns: ['connection_id', 'user_id', 'platform_id'];
            isOneToOne: false;
            referencedRelation: 'connections';
            referencedColumns: ['id', 'user_id', 'platform_id'];
          },
          {
            foreignKeyName: 'post_targets_post_id_user_id_fkey';
            columns: ['post_id', 'user_id'];
            isOneToOne: false;
            referencedRelation: 'post_status';
            referencedColumns: ['post_id', 'user_id'];
          },
          {
            foreignKeyName: 'post_targets_post_id_user_id_fkey';
            columns: ['post_id', 'user_id'];
            isOneToOne: false;
            referencedRelation: 'posts';
            referencedColumns: ['id', 'user_id'];
          },
        ];
      };
      posts: {
        Row: {
          app_id: string;
          content: NonNullable<Json>;
          created_at: string;
          external_ref: string | null;
          id: string;
          schedule_at: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          app_id: string;
          content: NonNullable<Json>;
          created_at?: string;
          external_ref?: string | null;
          id?: string;
          schedule_at?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          app_id?: string;
          content?: NonNullable<Json>;
          created_at?: string;
          external_ref?: string | null;
          id?: string;
          schedule_at?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'posts_app_id_fkey';
            columns: ['app_id'];
            isOneToOne: false;
            referencedRelation: 'client_apps';
            referencedColumns: ['id'];
          },
        ];
      };
      scope_requests: {
        Row: {
          app_id: string;
          completed_at: string | null;
          created_at: string;
          expires_at: string;
          id: string;
          platforms: string[];
          redirect_uri: string;
          scopes: string[];
          status: Database['poster']['Enums']['scope_request_status'];
          user_id: string;
        };
        Insert: {
          app_id: string;
          completed_at?: string | null;
          created_at?: string;
          expires_at?: string;
          id?: string;
          platforms: string[];
          redirect_uri: string;
          scopes: string[];
          status?: Database['poster']['Enums']['scope_request_status'];
          user_id: string;
        };
        Update: {
          app_id?: string;
          completed_at?: string | null;
          created_at?: string;
          expires_at?: string;
          id?: string;
          platforms?: string[];
          redirect_uri?: string;
          scopes?: string[];
          status?: Database['poster']['Enums']['scope_request_status'];
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'scope_requests_app_id_fkey';
            columns: ['app_id'];
            isOneToOne: false;
            referencedRelation: 'client_apps';
            referencedColumns: ['id'];
          },
        ];
      };
      target_transitions: {
        Row: {
          from_state: Database['poster']['Enums']['target_state'];
          to_state: Database['poster']['Enums']['target_state'];
        };
        Insert: {
          from_state: Database['poster']['Enums']['target_state'];
          to_state: Database['poster']['Enums']['target_state'];
        };
        Update: {
          from_state?: Database['poster']['Enums']['target_state'];
          to_state?: Database['poster']['Enums']['target_state'];
        };
        Relationships: [];
      };
      vault_access_log: {
        Row: {
          accessed_at: string;
          accessor: string;
          credential_id: string | null;
          id: number;
          purpose: string;
          target_id: string | null;
        };
        Insert: {
          accessed_at?: string;
          accessor: string;
          credential_id?: string | null;
          id?: never;
          purpose: string;
          target_id?: string | null;
        };
        Update: {
          accessed_at?: string;
          accessor?: string;
          credential_id?: string | null;
          id?: never;
          purpose?: string;
          target_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'vault_access_log_credential_id_fkey';
            columns: ['credential_id'];
            isOneToOne: false;
            referencedRelation: 'credentials';
            referencedColumns: ['id'];
          },
        ];
      };
      webhook_events: {
        Row: {
          app_id: string;
          attempt_count: number;
          delivered_at: string | null;
          external_ref: string | null;
          gave_up_at: string | null;
          id: string;
          last_error: string | null;
          next_attempt_at: string;
          occurred_at: string;
          payload: NonNullable<Json>;
          post_id: string | null;
          target_id: string | null;
          type: string;
        };
        Insert: {
          app_id: string;
          attempt_count?: number;
          delivered_at?: string | null;
          external_ref?: string | null;
          gave_up_at?: string | null;
          id?: string;
          last_error?: string | null;
          next_attempt_at?: string;
          occurred_at?: string;
          payload: NonNullable<Json>;
          post_id?: string | null;
          target_id?: string | null;
          type: string;
        };
        Update: {
          app_id?: string;
          attempt_count?: number;
          delivered_at?: string | null;
          external_ref?: string | null;
          gave_up_at?: string | null;
          id?: string;
          last_error?: string | null;
          next_attempt_at?: string;
          occurred_at?: string;
          payload?: NonNullable<Json>;
          post_id?: string | null;
          target_id?: string | null;
          type?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'webhook_events_app_id_fkey';
            columns: ['app_id'];
            isOneToOne: false;
            referencedRelation: 'client_apps';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Views: {
      post_status: {
        Row: {
          app_id: string | null;
          external_ref: string | null;
          post_id: string | null;
          state: string | null;
          target_count: number | null;
          user_id: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'posts_app_id_fkey';
            columns: ['app_id'];
            isOneToOne: false;
            referencedRelation: 'client_apps';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Functions: {
      claim_due_targets: {
        Args: { p_lease?: string; p_limit?: number; p_platform: string; p_worker: string };
        Returns: {
          attempt_count: number;
          claim_expires_at: string | null;
          claimed_by: string | null;
          connection_id: string;
          created_at: string;
          due_at: string;
          id: string;
          max_attempts: number;
          needs_reconciliation: boolean;
          next_attempt_at: string | null;
          overrides: NonNullable<Json>;
          paused_at: string | null;
          permalink: string | null;
          platform_id: string;
          platform_message: string | null;
          platform_post_id: string | null;
          position: number;
          post_id: string;
          posted_at: string | null;
          reason_class: Database['poster']['Enums']['reason_class'] | null;
          state: Database['poster']['Enums']['target_state'];
          updated_at: string;
          user_id: string;
        }[];
        SetofOptions: {
          from: '*';
          to: 'post_targets';
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      claim_webhook_events: {
        Args: { p_lease?: string; p_limit?: number };
        Returns: {
          app_id: string;
          attempt_count: number;
          delivered_at: string | null;
          external_ref: string | null;
          gave_up_at: string | null;
          id: string;
          last_error: string | null;
          next_attempt_at: string;
          occurred_at: string;
          payload: NonNullable<Json>;
          post_id: string | null;
          target_id: string | null;
          type: string;
        }[];
        SetofOptions: {
          from: '*';
          to: 'webhook_events';
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      expire_paused_targets: { Args: { p_grace?: string }; Returns: number };
      finish_dispatch: {
        Args: {
          p_attempt_no: number;
          p_http_status?: number;
          p_outcome: Database['poster']['Enums']['attempt_outcome'];
          p_permalink?: string;
          p_platform_message?: string;
          p_platform_post_id?: string;
          p_response?: Json;
          p_retry_at?: string;
          p_target: string;
          p_worker: string;
        };
        Returns: boolean;
      };
      grace_window: { Args: Record<PropertyKey, never>; Returns: string };
      mark_stale_dispatches: {
        Args: Record<PropertyKey, never>;
        Returns: {
          attempt_count: number;
          claim_expires_at: string | null;
          claimed_by: string | null;
          connection_id: string;
          created_at: string;
          due_at: string;
          id: string;
          max_attempts: number;
          needs_reconciliation: boolean;
          next_attempt_at: string | null;
          overrides: NonNullable<Json>;
          paused_at: string | null;
          permalink: string | null;
          platform_id: string;
          platform_message: string | null;
          platform_post_id: string | null;
          position: number;
          post_id: string;
          posted_at: string | null;
          reason_class: Database['poster']['Enums']['reason_class'] | null;
          state: Database['poster']['Enums']['target_state'];
          updated_at: string;
          user_id: string;
        }[];
        SetofOptions: {
          from: '*';
          to: 'post_targets';
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      pause_connection_targets: { Args: { p_connection: string }; Returns: number };
      resume_connection_targets: {
        Args: { p_connection: string; p_grace?: string };
        Returns: number;
      };
    };
    Enums: {
      attempt_outcome: 'in_flight' | 'success' | 'transient' | 'permanent' | 'unknown';
      connection_status: 'active' | 'expiring' | 'revoked';
      credential_kind: 'aggregator_profile' | 'oauth_token';
      media_kind: 'image' | 'video';
      media_status: 'pending_upload' | 'ready' | 'failed';
      reason_class:
        | 'transient_exhausted'
        | 'platform_rejected'
        | 'token_revoked_expired'
        | 'grant_revoked'
        | 'rendition_failed'
        | 'dispatch_outcome_unknown';
      rendition_status: 'pending' | 'ready' | 'failed';
      scope_request_status: 'pending' | 'completed' | 'denied' | 'expired';
      target_state:
        'accepted' | 'scheduled' | 'dispatching' | 'posted' | 'failed' | 'paused' | 'canceled';
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, 'public'>];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    ? (DefaultSchema['Tables'] & DefaultSchema['Views'])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema['Enums'] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums']
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums'][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema['Enums']
    ? DefaultSchema['Enums'][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema['CompositeTypes'] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes']
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes'][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema['CompositeTypes']
    ? DefaultSchema['CompositeTypes'][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  poster: {
    Enums: {
      attempt_outcome: ['in_flight', 'success', 'transient', 'permanent', 'unknown'],
      connection_status: ['active', 'expiring', 'revoked'],
      credential_kind: ['aggregator_profile', 'oauth_token'],
      media_kind: ['image', 'video'],
      media_status: ['pending_upload', 'ready', 'failed'],
      reason_class: [
        'transient_exhausted',
        'platform_rejected',
        'token_revoked_expired',
        'grant_revoked',
        'rendition_failed',
        'dispatch_outcome_unknown',
      ],
      rendition_status: ['pending', 'ready', 'failed'],
      scope_request_status: ['pending', 'completed', 'denied', 'expired'],
      target_state: [
        'accepted',
        'scheduled',
        'dispatching',
        'posted',
        'failed',
        'paused',
        'canceled',
      ],
    },
  },
} as const;
