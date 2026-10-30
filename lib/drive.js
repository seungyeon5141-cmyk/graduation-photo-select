// Reads class photos from a Google Drive folder shared as "anyone with the link can view".
// Expected layout: <DRIVE_FOLDER_ID>/1반, /2반, ... /5반 each holding image files
// (images in deeper sub-folders of a class folder are included too). Images in the root folder or
// in folders without a class number are kept under class 0, which only teachers can see.
const API = 'https://www.googleapis.com/drive/v3/files';
const DEFAULT_FOLDER = '1QobfIH_5WpmLVjGUve5CxEeS2p-DtFk2';
const CACHE_MS = 5 * 60 * 1000;

let cache = null; // { at, classes: Map<classNo, photo[]>, byId: Map<id, photo> }

export function driveConfigured() {
  return Boolean(process.env.GOOGLE_API_KEY);
}

function key() {
  const k = process.env.GOOGLE_API_KEY;
  if (!k) throw new Error('GOOGLE_API_KEY 환경 변수가 없어요.');
  return k;
}

async function listChildren(folderId) {
  const out = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, size, imageMediaMetadata(width, height))',
      pageSize: '1000',
      orderBy: 'name_natural',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      key: key(),
    });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await fetch(`${API}?${params}`);
    if (!res.ok) throw new Error(`구글 드라이브 목록을 읽지 못했어요 (${res.status}). 폴더가 '링크가 있는 모든 사용자'로 공유되었는지 확인하세요.`);
    const data = await res.json();
    out.push(...(data.files || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return out;
}

const isFolder = (f) => f.mimeType === 'application/vnd.google-apps.folder';
const isImage = (f) => String(f.mimeType).startsWith('image/');

async function collectImages(folderId, depth, prefix) {
  const items = await listChildren(folderId);
  const photos = items.filter(isImage).map((f) => ({
    id: f.id,
    name: prefix + f.name,
    mimeType: f.mimeType,
    size: Number(f.size) || 0,
    width: f.imageMediaMetadata?.width || null,
    height: f.imageMediaMetadata?.height || null,
  }));
  if (depth > 0) {
    for (const sub of items.filter(isFolder)) photos.push(...await collectImages(sub.id, depth - 1, `${prefix}${sub.name}/`));
  }
  return photos;
}

export function classFromFolderName(name) {
  const m = String(name).match(/(\d+)\s*반/) || String(name).match(/^\s*(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

export async function loadPhotos({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache;
  const root = process.env.DRIVE_FOLDER_ID || DEFAULT_FOLDER;
  const classes = new Map();
  const top = await listChildren(root);
  const add = (classNo, photos) => classes.set(classNo, [...(classes.get(classNo) || []), ...photos.map((p) => ({ ...p, classNo }))]);
  for (const folder of top.filter(isFolder)) {
    const classNo = classFromFolderName(folder.name);
    add(classNo || 0, await collectImages(folder.id, 2, classNo ? '' : `${folder.name}/`));
  }
  add(0, top.filter(isImage).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, size: Number(f.size) || 0, width: null, height: null })));
  if (!classes.get(0).length) classes.delete(0);
  const byId = new Map();
  for (const list of classes.values()) for (const p of list) byId.set(p.id, p);
  cache = { at: Date.now(), classes, byId };
  return cache;
}

// Thumbnail bytes via the file's thumbnailLink, resized by Google (s<N> = longest side).
export async function fetchThumbnail(fileId, size) {
  const params = new URLSearchParams({ fields: 'thumbnailLink', supportsAllDrives: 'true', key: key() });
  const meta = await fetch(`${API}/${encodeURIComponent(fileId)}?${params}`);
  if (!meta.ok) throw new Error(`thumbnail meta ${meta.status}`);
  const { thumbnailLink } = await meta.json();
  if (!thumbnailLink) throw new Error('no thumbnail');
  return fetch(thumbnailLink.replace(/=s\d+$/, `=s${size}`));
}

export async function fetchOriginal(fileId) {
  const params = new URLSearchParams({ alt: 'media', supportsAllDrives: 'true', key: key() });
  return fetch(`${API}/${encodeURIComponent(fileId)}?${params}`);
}

export function extensionOf(photo) {
  const m = String(photo.name).match(/\.([A-Za-z0-9]{2,5})$/);
  if (m) return '.' + m[1].toLowerCase();
  const byMime = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/heic': '.heic', 'image/webp': '.webp', 'image/tiff': '.tif' };
  return byMime[photo.mimeType] || '';
}

// The name the vendor receives, e.g. "3반_2조.jpg".
export const deliveryName = (classNo, groupNo, photo) => `${classNo}반_${groupNo}조${photo ? extensionOf(photo) : ''}`;

// Whole-class photo chosen by the teacher, e.g. "3반_단체.jpg".
export const classPhotoName = (classNo, photo) => `${classNo}반_단체${photo ? extensionOf(photo) : ''}`;
