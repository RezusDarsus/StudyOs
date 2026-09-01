import {
  buildRuntimeKnowledgePort,
  setRuntimeKnowledge,
  type RuntimeContentPack,
  type RuntimeKnowledgePort,
} from './ai/runtime-knowledge.js';
import { goalCategoryPack } from './domain-content/goal-category.js';
import { goalDomainPack, goalDomainSuccessPack } from './domain-content/goal-domains.js';
import { questionTopicPack } from './domain-content/question-topics.js';
import { statedTopicPack } from './domain-content/stated-topics.js';
import {
  commitmentActivityVerbPack,
  missedActivityNounPack,
  recommendationTopicPack,
  recommendationMaterialPack,
  createVerbPack,
  trainingNounPack,
} from './domain-content/routing-vocabulary.js';
import { taskRolePack } from './domain-content/task-roles.js';
import { explicitActivityPack } from './domain-content/explicit-activities.js';
import { learnableSubjectPack, quantityUnitPack } from './domain-content/readiness-vocabulary.js';
import { nonMeasurableQualityPack } from './domain-content/feasibility-vocabulary.js';

/**
 * THE composition root for runtime domain content.
 *
 * This is the only module allowed to import the domain-content packs, and it
 * performs one explicit, greppable act: `installRuntimeContent()` validates
 * every pack and installs the resulting immutable port. There is no
 * import-time side effect — a process that never calls this function reads
 * the NullPort, and the flag-gated consumers see empty lexicons (which
 * config-audit flags as a misconfiguration when the runtime-content flag is
 * on without a bootstrap).
 *
 * Malformed packs fail here, at startup, before the first request.
 */
const PACKS: readonly RuntimeContentPack[] = [
  goalCategoryPack,
  goalDomainPack,
  goalDomainSuccessPack,
  questionTopicPack,
  statedTopicPack,
  createVerbPack,
  missedActivityNounPack,
  commitmentActivityVerbPack,
  trainingNounPack,
  recommendationTopicPack,
  recommendationMaterialPack,
  taskRolePack,
  explicitActivityPack,
  learnableSubjectPack,
  quantityUnitPack,
  nonMeasurableQualityPack,
];

export function installRuntimeContent(): RuntimeKnowledgePort {
  const port = buildRuntimeKnowledgePort(PACKS);
  setRuntimeKnowledge(port);
  return port;
}
