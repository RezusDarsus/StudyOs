package com.studyos.support;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import java.sql.Connection;
import java.sql.Statement;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.utility.DockerImageName;

/**
 * Real PostgreSQL+pgvector for integration tests, with a disposable database per test JVM.
 *
 * <p>Strategy, in order:
 * <ol>
 *   <li>Testcontainers (pgvector image) when a working Docker endpoint is available — the
 *       cleanest option, used in CI;</li>
 *   <li>a dedicated {@code studyos_it} database on the development PostgreSQL instance that
 *       StudyOS already requires. The database is dropped and recreated at the start of every
 *       test JVM and only ever truncated between test classes, so the developer's own
 *       {@code studyos} database is never touched.</li>
 * </ol>
 * Either way the tests run against actual PostgreSQL semantics — upserts, unique constraints,
 * generated columns, advisory locks — instead of mocked SQL.
 */
public final class PostgresSupport {
    private static PostgreSQLContainer<?> container;
    private static HikariDataSource dataSource;
    private static JdbcTemplate jdbc;
    private static DataSourceTransactionManager transactionManager;
    private static String mode;

    private static String envOr(String name, String fallback) {
        String value = System.getenv(name);
        return value == null || value.isBlank() ? fallback : value;
    }

    private PostgresSupport() {}

    public static synchronized JdbcTemplate jdbc() {
        if (jdbc == null) {
            if (tryTestcontainers()) {
                mode = "testcontainers";
            } else {
                mode = "local-instance";
                prepareLocalDatabase();
            }
            HikariConfig config = new HikariConfig();
            config.setJdbcUrl(currentUrl());
            config.setUsername(currentUser());
            config.setPassword(currentPassword());
            config.setMaximumPoolSize(12);
            dataSource = new HikariDataSource(config);
            Flyway.configure().dataSource(currentUrl(), currentUser(), currentPassword()).load().migrate();
            jdbc = new JdbcTemplate(dataSource);
            transactionManager = new DataSourceTransactionManager(dataSource());
        }
        return jdbc;
    }

    public static String mode() { return mode; }

    private static String currentUrl() {
        return container == null
                ? envOr("STUDYOS_IT_URL", "jdbc:postgresql://" + envOr("STUDYOS_IT_HOST", "localhost") + ":" + envOr("STUDYOS_IT_PORT", "5432") + "/" + envOr("STUDYOS_IT_DB", "studyos_it"))
                : container.getJdbcUrl();
    }

    private static String currentUser() {
        return container == null ? envOr("STUDYOS_IT_USER", "studyos") : container.getUsername();
    }

    private static String currentPassword() {
        return container == null ? envOr("STUDYOS_IT_PASSWORD", "studyos") : container.getPassword();
    }

    private static boolean tryTestcontainers() {
        try {
            container = new PostgreSQLContainer<>(DockerImageName.parse("pgvector/pgvector:pg16").asCompatibleSubstituteFor("postgres"))
                    .withDatabaseName("studyos_it").withUsername("studyos").withPassword("studyos");
            container.start();
            return true;
        } catch (Throwable failure) {
            if (container != null) container.close();
            container = null;
            System.out.println("[studyos-it] Testcontainers unavailable (" + failure.getClass().getSimpleName() + "), falling back to the local PostgreSQL instance.");
            return false;
        }
    }

    /**
     * Drops and recreates the integration database on the shared instance, so every JVM runs the
     * full V1→latest migration chain from empty. Falls back to reusing an existing database when
     * the role lacks CREATE DATABASE rights; truncation between classes still gives isolation.
     */
    private static void prepareLocalDatabase() {
        String database = envOr("STUDYOS_IT_DB", "studyos_it");
        String maintenanceUrl = envOr("STUDYOS_IT_URL", "jdbc:postgresql://" + envOr("STUDYOS_IT_HOST", "localhost") + ":" + envOr("STUDYOS_IT_PORT", "5432") + "/studyos").replaceFirst("/[^/?]+$", "/studyos");
        try (Connection connection = java.sql.DriverManager.getConnection(maintenanceUrl, currentUser(), currentPassword());
             Statement statement = connection.createStatement()) {
            statement.execute("DROP DATABASE IF EXISTS " + database + " WITH (FORCE)");
            statement.execute("CREATE DATABASE " + database);
        } catch (Exception failure) {
            System.out.println("[studyos-it] Could not recreate " + database + " (" + failure.getMessage() + "); reusing whatever state it has.");
        }
    }

    public static DataSource dataSource() {
        jdbc();
        return dataSource;
    }

    public static DataSourceTransactionManager transactionManager() {
        jdbc();
        return transactionManager;
    }

    /** Truncates every user table so each test class starts from a clean, fully-migrated database. */
    public static synchronized void reset() {
        jdbc().execute("""
                DO $$ DECLARE r record; BEGIN
                  FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> 'flyway_schema_history') LOOP
                    EXECUTE 'TRUNCATE TABLE public.' || quote_ident(r.tablename) || ' CASCADE';
                  END LOOP;
                END $$;
                """);
    }

    public static UUID insertCourse() {
        UUID id = UUID.randomUUID();
        jdbc().update("INSERT INTO courses(id,name,description) VALUES(?,?,'Integration test course')", id, "Course " + id);
        return id;
    }

    public static UUID insertDocument(UUID courseId, String type) {
        UUID id = UUID.randomUUID();
        jdbc().update("INSERT INTO documents(id,course_id,name,document_type,storage_path,status,source_metadata) VALUES(?,?,?,?,?,?,'{}'::jsonb)",
                id, courseId, "doc-" + id + ".txt", type, "data/it/doc-" + id + ".txt", "COMPLETED");
        return id;
    }

    public static UUID insertChunk(UUID courseId, UUID documentId, int ordinal, String content) {
        UUID id = UUID.randomUUID();
        jdbc().update("INSERT INTO chunks(id,course_id,document_id,ordinal,content) VALUES(?,?,?,?,?)", id, courseId, documentId, ordinal, content);
        return id;
    }

    public static UUID insertTopic(UUID courseId, String name) {
        UUID id = UUID.randomUUID();
        String normalized = name.toLowerCase().replaceAll("[^a-z0-9]+", " ").trim().replaceAll("\\s+", " ");
        jdbc().update("INSERT INTO topics(id,course_id,canonical_name,normalized_name) VALUES(?,?,?,?) ON CONFLICT (course_id,normalized_name) DO NOTHING",
                id, courseId, name, normalized);
        return jdbc().queryForObject("SELECT id FROM topics WHERE course_id=? AND normalized_name=?", UUID.class, courseId, normalized);
    }
}
