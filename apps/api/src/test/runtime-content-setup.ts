import { installRuntimeContent } from '../runtime-content.js';

// Stage 6: the domain vocabularies are runtime DATA behind the RuntimeKnowledge
// port, and the legacy inline tables are gone. Every unit test that compiles
// them — category scoring, intent routing, role detection, activity coverage,
// feasibility nouns, topic classification — needs the port installed first.
// The installer is idempotent at module scope and explicit, matching the
// server's own bootstrap.
installRuntimeContent();
