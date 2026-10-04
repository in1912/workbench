<template>
  <div>
    <div v-if="!rows.length" class="empty" style="padding:14px 0">
      还没有关联。关联是这套系统的核心——目标、行动、笔记、账单之间连起来，才不是一堆孤立的表。
    </div>
    <div v-for="(e, i) in rows" :key="i" class="list-item">
      <span class="t">
        <span class="badge gray" :style="{ marginRight: '6px' }">{{ ENTITY_LABEL[e.other.type] || e.other.type }}</span>
        {{ entityTitle(e) }}
      </span>
      <span class="meta">
        <span class="muted">{{ e.dir === 'out' ? '→' : '←' }} {{ RELATION_LABEL[e.relation] || e.relation }}</span>
        <button v-if="canEdit" class="small danger" title="删除这条关联" @click="remove(e)">删</button>
      </span>
    </div>

    <div v-if="canEdit" class="row" style="margin-top:10px">
      <select v-model="form.type" style="flex:0 0 96px">
        <option v-for="t in types" :key="t" :value="t">{{ ENTITY_LABEL[t] || t }}</option>
      </select>
      <input v-model.number="form.id" type="number" min="1" placeholder="ID" style="flex:0 0 80px" />
      <select v-model="form.relation" style="flex:0 0 96px">
        <option v-for="r in relations" :key="r" :value="r">{{ RELATION_LABEL[r] }}</option>
      </select>
      <button class="small" :disabled="!form.id" @click="add">建立关联</button>
    </div>
    <div v-if="canEdit" class="muted" style="margin-top:6px">
      填的是对方实体的 id（目标/行动/笔记的 id 在各自页面能看到）。方向不用纠结：关联是无向的，正着连反着连都能查到。
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import { api } from '../../api';
import { RELATION_LABEL, ENTITY_LABEL, entityTitle } from './lifeUtils';

const props = defineProps({
  // 当前实体：{ type, id }
  type: { type: String, required: true },
  id: { type: [Number, String], required: true },
  links: { type: Object, default: () => ({ out: [], in: [] }) },
  canEdit: { type: Boolean, default: true },
});
const emit = defineEmits(['toast', 'changed']);

const relations = ['belongs', 'supports', 'produces', 'derives', 'reviews', 'relates'];
// 能连的实体类型：与后端 lifeLinkService.ENTITY 一致
const types = ['goal', 'kr', 'task', 'habit', 'project', 'note', 'domain', 'sop', 'bill', 'family', 'kid', 'skill', 'file', 'review'];

const rows = computed(() => [...(props.links.out || []), ...(props.links.in || [])]);
const form = ref({ type: 'note', id: null, relation: 'relates' });

async function add() {
  try {
    await api.post('/life/links', {
      src_type: props.type, src_id: Number(props.id),
      dst_type: form.value.type, dst_id: Number(form.value.id),
      relation: form.value.relation,
    });
    form.value.id = null;
    emit('changed');
    emit('toast', '已关联');
  } catch (e) { emit('toast', e.message, 'err'); }
}

async function remove(e) {
  // e.id 是 life_links 这一行的主键（出边入边都有）。后端按 id 取出该行、
  // 再按行里记录的方向去删，所以出边入边走同一个端点，前端不用区分方向。
  try {
    await api.del(`/life/links/${e.id}`);
    emit('changed');
    emit('toast', '已解除关联');
  } catch (err) { emit('toast', err.message, 'err'); }
}
</script>
