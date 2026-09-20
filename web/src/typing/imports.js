// 我的打字内容（服务端 typing_imports 表）：每人自己导入/选择/删除
import { api } from '../api';

export function listImports(kind) {
  return api.get(`/typing/imports${kind ? `?kind=${kind}` : ''}`);
}
export function saveImport(payload) {
  return api.post('/typing/imports', payload);
}
export function deleteImport(id) {
  return api.del(`/typing/imports/${id}`);
}
