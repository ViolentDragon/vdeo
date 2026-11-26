export const CLOUD_DRIVES = [
  { id: '115', name: '115网盘', mark: '115', color: '#1c55c8', guideUrl: 'https://doc.oplist.org/guide/drivers/115' },
  { id: 'quark', name: '夸克网盘', mark: '夸', color: '#583cc5', guideUrl: 'https://doc.oplist.org/guide/drivers/quark' },
  { id: 'uc', name: 'UC网盘', mark: 'UC', color: '#087485', guideUrl: 'https://doc.oplist.org/guide/drivers/uc' },
  { id: 'guangya', name: '光鸭云盘', mark: '光', color: '#a3410b', guideUrl: 'https://doc.oplist.org/guide/drivers/guangyapan' },
  { id: 'tianyi', name: '天翼云盘', mark: '天', color: '#bd3439', guideUrl: 'https://doc.oplist.org/guide/drivers/189' },
  { id: 'pan123', name: '123网盘', mark: '123', color: '#0a794e', guideUrl: 'https://doc.oplist.org/guide/drivers/123' },
  { id: 'aliyun', name: '阿里云盘', mark: '阿', color: '#404ab3' },
] as const;

export type CloudDriveId = (typeof CLOUD_DRIVES)[number]['id'];
export type BridgedDriveId = Exclude<CloudDriveId, 'aliyun'>;
