import manifestJson from '../assets/material-icons/manifest.json';

/**
 * Material Icon Theme (MIT) file and folder icons, vendored from
 * material-icon-theme. Vite turns every SVG into a hashed asset URL; the
 * manifest maps names/extensions/folder names to those icons.
 *
 * Matching order follows the theme: exact file name, then the longest
 * extension suffix, then the generic file icon. Folders use their named icon
 * and switch to the "open" variant while expanded.
 */
interface IconManifest {
  file: string;
  folder: string;
  folderExpanded: string;
  fileNames: Record<string, string>;
  fileExtensions: Record<string, string>;
  folderNames: Record<string, string>;
  folderNamesExpanded: Record<string, string>;
  iconFiles: Record<string, string>;
}

const manifest = manifestJson as IconManifest;

const ICON_URLS = import.meta.glob('../assets/material-icons/*.svg', {
  // no-inline keeps the tiny SVGs as files instead of base64 in the bundle.
  query: '?url&no-inline',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const URL_BY_FILE = new Map<string, string>();
for (const [key, url] of Object.entries(ICON_URLS)) {
  const file = key.slice(key.lastIndexOf('/') + 1);
  URL_BY_FILE.set(file, url);
}

function svgFile(icon: string): string {
  return manifest.iconFiles[icon] ?? `${icon}.svg`;
}

/** Longest suffix first: foo.test.ts → foo.test.ts, test.ts, ts. */
function extensionCandidates(lower: string): string[] {
  const candidates = [lower];
  let index = lower.indexOf('.');
  while (index !== -1) {
    candidates.push(lower.slice(index + 1));
    index = lower.indexOf('.', index + 1);
  }
  return candidates;
}

function iconFor(name: string, isDir: boolean, open: boolean): string {
  const lower = name.toLowerCase();

  if (isDir) {
    const map = open ? manifest.folderNamesExpanded : manifest.folderNames;
    return map[lower] ?? (open ? manifest.folderExpanded : manifest.folder);
  }

  const named = manifest.fileNames[lower];
  if (named) return named;

  for (const candidate of extensionCandidates(lower)) {
    const icon = manifest.fileExtensions[candidate];
    if (icon) return icon;
  }
  return manifest.file;
}

interface Props {
  name: string;
  isDir?: boolean;
  /** A folder that is currently expanded uses its open icon. */
  open?: boolean;
  size?: number;
}

export function MaterialFileIcon({ name, isDir = false, open = false, size = 16 }: Props) {
  const url = URL_BY_FILE.get(svgFile(iconFor(name, isDir, open)));
  if (!url) return null;
  return (
    <img
      className="material-icon"
      src={url}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
