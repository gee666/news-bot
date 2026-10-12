/** Latest current assessment wins over archived merge judgments, per URL and story. */
export const fetchedRelevanceCte = `fetched_assessments AS (
  SELECT e.url,e.canonical_url,se.relevance,se.assessed_at,e.fetched_at,e.id,0 AS priority
    FROM story_evidence se JOIN evidence_documents e ON e.id=se.evidence_id
    WHERE se.story_id=$1 AND se.superseded_at IS NULL AND (se.assessed_at IS NOT NULL OR se.relevance<>'uncertain')
  UNION ALL
  SELECT e.url,e.canonical_url,a.relevance,a.assessed_at,e.fetched_at,e.id,1
    FROM story_merge_evidence a JOIN evidence_documents e ON e.id=a.evidence_id
    WHERE a.canonical_story_id=$1 AND (a.assessed_at IS NOT NULL OR a.relevance<>'uncertain')
), fetched_relevance AS (
  SELECT DISTINCT ON (split_part(alias.url,'#',1)) split_part(alias.url,'#',1) AS url,a.relevance
    FROM fetched_assessments a CROSS JOIN LATERAL unnest(ARRAY[a.url,a.canonical_url]) AS alias(url)
    WHERE alias.url IS NOT NULL
    ORDER BY split_part(alias.url,'#',1),a.priority,a.assessed_at DESC NULLS LAST,a.fetched_at DESC,a.id
)`;
