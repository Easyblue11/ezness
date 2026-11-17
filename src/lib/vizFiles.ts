import type { WorkspaceVizTable } from '../types';
import { parseTableFile } from './vizTables';

/**
 * Tables the agent wrote into the workspace folder.
 *
 * The main process reads them now (CSV/TSV, Excel workbooks, SQLite databases,
 * JSON and Markdown tables), because binary formats cannot go through the text
 * reader. The old root-only text path stays as a fallback for remote
 * workspaces and older builds.
 */

const TABLE_FILE = /\.(csv|tsv|md|markdown|txt|json)$/i;
const MAX_FILES = 6;
const MAX_TABLES = 8;

export async function collectLocalTables(workspaceId: string): Promise<WorkspaceVizTable[]> {
  const api = window.ezness;
  if (!workspaceId) return [];

  if (api?.workspaceVizTables) {
    try {
      const result = await api.workspaceVizTables({ workspaceId });
      if (result?.ok && Array.isArray(result.tables) && result.tables.length > 0) {
        return result.tables;
      }
    } catch {
      /* fall through to the text reader */
    }
  }

  return collectTextTables(workspaceId);
}

async function collectTextTables(workspaceId: string): Promise<WorkspaceVizTable[]> {
  const api = window.ezness;
  if (!api?.workspaceTree || !api?.workspaceReadFile) return [];
  try {
    const tree = await api.workspaceTree({ workspaceId });
    if (!tree?.ok || !Array.isArray(tree.entries)) return [];
    const files = tree.entries
      .filter((entry) => !entry.isDir && TABLE_FILE.test(entry.name))
      .slice(0, MAX_FILES);

    const tables: WorkspaceVizTable[] = [];
    for (const file of files) {
      try {
        const read = await api.workspaceReadFile({ workspaceId, path: file.path });
        if (!read?.ok || read.kind !== 'text' || !read.content) continue;
        tables.push(...parseTableFile(read.content, read.name || file.name));
      } catch {
        /* one unreadable file must not stop the rest */
      }
      if (tables.length >= MAX_TABLES) break;
    }
    return tables;
  } catch {
    return [];
  }
}
