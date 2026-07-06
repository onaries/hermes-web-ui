<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { NAlert, NButton, NInput, NInputNumber, NSelect, NSpace, NSwitch, NText, useMessage } from "naive-ui";
import { useI18n } from "vue-i18n";
import { useSettingsStore } from "@/stores/hermes/settings";
import { useSessionBrowserPrefsStore } from "@/stores/hermes/session-browser-prefs";
import SettingRow from "./SettingRow.vue";

const settingsStore = useSettingsStore();
const sessionBrowserPrefsStore = useSessionBrowserPrefsStore();
const message = useMessage();
const { t } = useI18n();
const workspaceBaseDraft = ref("");

watch(() => settingsStore.workspace.base, (value) => {
  workspaceBaseDraft.value = value || "";
}, { immediate: true });

const workspaceBaseSourceLabel = computed(() => {
  const source = settingsStore.workspace.source || "home";
  if (source === "env") return t("settings.session.workspaceBaseSourceEnv");
  if (source === "app") return t("settings.session.workspaceBaseSourceApp");
  return t("settings.session.workspaceBaseSourceHome");
});

const workspaceBaseEffective = computed(() => settingsStore.workspace.effective_base || "");
const workspaceBaseLockedByEnv = computed(() => settingsStore.workspace.source === "env");
const workspaceBaseEnvOverride = computed(() => settingsStore.workspace.env_override || "");



// 防抖保存：每个字段独立定时器，300ms 内只发最后一次 HTTP 请求
const debounceTimers: Record<string, ReturnType<typeof setTimeout>> = {};

function save(values: Record<string, any>) {
  // NSelect/NSwitch 等一次性操作，直接保存，不需要防抖
  settingsStore.updateLocal('session_reset', values)
  settingsStore.saveSection('session_reset', values).then(() => {
    message.success(t("settings.saved"));
  }).catch(() => {
    message.error(t("settings.saveFailed"));
  });
}

function debouncedSave(key: string, value: any) {
  // 先立即更新本地 store（UI 即时响应）
  settingsStore.updateLocal('session_reset', { [key]: value });
  // 再防抖发 HTTP 保存
  if (debounceTimers[key]) clearTimeout(debounceTimers[key])
  debounceTimers[key] = setTimeout(async () => {
    try {
      await settingsStore.saveSection('session_reset', { [key]: value });
      message.success(t("settings.saved"));
    } catch (err: any) {
      message.error(t("settings.saveFailed"));
    }
  }, 300);
}

async function toggleRequireAuth(value: boolean) {
  try {
    await settingsStore.saveSection("approvals", { mode: value ? "manual" : "off" });
    message.success(t("settings.saved"));
  } catch (err: any) {
    message.error(t("settings.saveFailed"));
  }
}

async function toggleWriteApproval(section: "memory" | "skills", value: boolean) {
  try {
    settingsStore.updateLocal(section, { write_approval: value });
    await settingsStore.saveSection(section, { write_approval: value });
    message.success(t("settings.saved"));
  } catch (err: any) {
    message.error(t("settings.saveFailed"));
  }
}

async function saveWorkspaceBase() {
  if (!ensureWorkspaceBaseEditable()) return;
  try {
    const base = workspaceBaseDraft.value.trim();
    settingsStore.updateLocal("workspace", { base });
    await settingsStore.saveSection("workspace", { base });
    await settingsStore.fetchSettings();
    workspaceBaseDraft.value = settingsStore.workspace.base || "";
    message.success(t("settings.saved"));
  } catch (err: any) {
    message.error(err?.message || t("settings.saveFailed"));
  }
}

function ensureWorkspaceBaseEditable(): boolean {
  if (!workspaceBaseLockedByEnv.value) return true;
  message.warning(t("settings.session.workspaceBaseEnvLocked"));
  workspaceBaseDraft.value = settingsStore.workspace.base || "";
  return false;
}


async function resetWorkspaceBase() {
  workspaceBaseDraft.value = "";
  if (!ensureWorkspaceBaseEditable()) return;
  await saveWorkspaceBase();
}

</script>

<template>
  <section class="settings-section">
    <SettingRow
      :label="t('settings.session.workspaceBase')"
      :hint="t('settings.session.workspaceBaseHint')"
    >
      <div class="workspace-base-control">
        <NSpace align="center" :wrap="false">
          <NInput
            v-model:value="workspaceBaseDraft"
            :placeholder="t('settings.session.workspaceBasePlaceholder')"
            size="small"
            class="workspace-base-input"
            :disabled="workspaceBaseLockedByEnv"
            @keyup.enter="saveWorkspaceBase"
          />
          <NButton size="small" type="primary" :disabled="workspaceBaseLockedByEnv" @click="saveWorkspaceBase">
            {{ t("common.save") }}
          </NButton>
          <NButton size="small" :disabled="workspaceBaseLockedByEnv" @click="resetWorkspaceBase">
            {{ t("common.reset") }}
          </NButton>
        </NSpace>
        <NText depth="3" class="workspace-base-status">
          {{ t("settings.session.workspaceBaseEffective", { path: workspaceBaseEffective || "-" }) }}
          · {{ workspaceBaseSourceLabel }}
        </NText>
        <NAlert
          v-if="workspaceBaseLockedByEnv"
          type="warning"
          :show-icon="false"
          class="workspace-base-alert"
        >
          {{ t("settings.session.workspaceBaseEnvOverride", { path: workspaceBaseEnvOverride || workspaceBaseEffective || "-" }) }}
        </NAlert>
      </div>
    </SettingRow>
    <SettingRow
      :label="t('settings.session.requireAuth')"
      :hint="t('settings.session.requireAuthHint')"
    >
      <NSwitch :value="settingsStore.approvals.mode === 'manual'" @update:value="toggleRequireAuth" />
    </SettingRow>
    <SettingRow
      :label="t('settings.session.memoryWriteApproval')"
      :hint="t('settings.session.memoryWriteApprovalHint')"
    >
      <NSwitch
        :value="settingsStore.memory.write_approval === true"
        @update:value="(value) => toggleWriteApproval('memory', value)"
      />
    </SettingRow>
    <SettingRow
      :label="t('settings.session.skillsWriteApproval')"
      :hint="t('settings.session.skillsWriteApprovalHint')"
    >
      <NSwitch
        :value="settingsStore.skills.write_approval === true"
        @update:value="(value) => toggleWriteApproval('skills', value)"
      />
    </SettingRow>
    <SettingRow
      :label="t('settings.session.mode')"
      :hint="t('settings.session.modeHint')"
    >
      <NSelect
        :value="settingsStore.sessionReset.mode || 'both'"
        :options="[
          { label: t('settings.session.modeBoth'), value: 'both' },
          { label: t('settings.session.modeIdle'), value: 'idle' },
          { label: t('settings.session.modeDaily'), value: 'daily' },
          { label: t('settings.session.modeNone'), value: 'none' },
        ]"
        size="small"
        class="input-md"
        @update:value="(v) => save({ mode: v })"
      />
    </SettingRow>
    <SettingRow
      :label="t('settings.session.idleMinutes')"
      :hint="t('settings.session.idleMinutesHint')"
    >
      <NInputNumber
        :value="settingsStore.sessionReset.idle_minutes"
        :min="10"
        :max="10080"
        :step="30"
        size="small"
        class="input-sm"
        @update:value="(v) => v != null && debouncedSave('idle_minutes', v)"
      />
    </SettingRow>
    <SettingRow
      :label="t('settings.session.atHour')"
      :hint="t('settings.session.atHourHint')"
    >
      <NInputNumber
        :value="settingsStore.sessionReset.at_hour"
        :min="0"
        :max="23"
        :step="1"
        size="small"
        class="input-sm"
        @update:value="(v) => v != null && debouncedSave('at_hour', v)"
      />
    </SettingRow>
    <SettingRow
      :label="t('settings.session.liveMonitorHumanOnly')"
      :hint="t('settings.session.liveMonitorHumanOnlyHint')"
    >
      <NSwitch
        :value="sessionBrowserPrefsStore.humanOnly"
        @update:value="(value) => sessionBrowserPrefsStore.setHumanOnly(value)"
      />
    </SettingRow>
  </section>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.settings-section {
  margin-top: 16px;
}

.workspace-base-control {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: stretch;
}

.workspace-base-input {
  min-width: 320px;
}

.workspace-base-status {
  font-size: 12px;
  overflow-wrap: anywhere;
}

.workspace-base-alert {
  font-size: 12px;
}
</style>
