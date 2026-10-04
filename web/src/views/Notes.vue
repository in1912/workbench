<template>
  <NotesShell />
</template>

<script setup>
// v1.9.41：笔记页的路由与权限（meta.page='notes'）一行不动，页面本体交给三栏外壳。
// 保留这一层薄包装而不是直接把 NotesShell 挂到路由上，是为了将来能在这里做「按路由区分视图」
// 而不动外壳内部。
import NotesShell from '../components/notes/NotesShell.vue';
</script>
