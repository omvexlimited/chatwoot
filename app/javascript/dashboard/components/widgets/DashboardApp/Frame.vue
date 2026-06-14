<script>
import LoadingState from 'dashboard/components/widgets/LoadingState.vue';
import { BUS_EVENTS } from 'shared/constants/busEvents';
import { emitter } from 'shared/helpers/mitt';

export default {
  components: {
    LoadingState,
  },
  props: {
    config: {
      type: Array,
      default: () => [],
    },
    currentChat: {
      type: Object,
      default: () => ({}),
    },
    isVisible: {
      type: Boolean,
      default: false,
    },
    position: {
      type: Number,
      required: true,
    },
    mode: {
      type: String,
      default: 'tab',
    },
  },
  data() {
    return {
      hasOpenedAtleastOnce: false,
      iframeLoading: true,
    };
  },
  computed: {
    dashboardAppContext() {
      return {
        conversation: this.currentChat,
        contact: this.$store.getters['contacts/getContact'](this.contactId),
        currentAgent: this.currentAgent,
      };
    },
    contactId() {
      return this.currentChat?.meta?.sender?.id;
    },
    currentAgent() {
      const { id, name, email } = this.$store.getters.getCurrentUser;
      return { id, name, email };
    },
  },
  watch: {
    isVisible: {
      immediate: true,
      handler() {
        if (!this.isVisible) return;
        this.hasOpenedAtleastOnce = true;
        this.postContextToFrames();
      },
    },
    dashboardAppContext: {
      deep: true,
      handler() {
        if (this.isVisible && this.hasOpenedAtleastOnce) {
          this.postContextToFrames();
        }
      },
    },
  },
  mounted() {
    window.addEventListener('message', this.triggerEvent);
  },
  unmounted() {
    window.removeEventListener('message', this.triggerEvent);
  },
  methods: {
    triggerEvent(event) {
      if (!this.isVisible) return;
      if (event.data === 'chatwoot-dashboard-app:fetch-info') {
        this.onIframeLoad(0);
        return;
      }

      const message = this.parseDashboardAppMessage(event.data);
      if (
        message?.event !== 'kr-copilot:insert-reply' &&
        message?.event !== 'kr-copilot:get-reply-editor-content'
      ) {
        return;
      }

      const trustedFrame = this.findTrustedFrame(event);
      if (!trustedFrame) return;

      const requestId = message.data?.requestId;
      const conversationId = message.data?.conversation_id;
      if (!this.isCurrentConversation(conversationId)) {
        this.postCopilotMessageResult(event, message.event, {
          ok: false,
          requestId,
          error: 'Conversation changed before the composer action could run.',
        });
        return;
      }

      if (message.event === 'kr-copilot:get-reply-editor-content') {
        emitter.emit(BUS_EVENTS.GET_REPLY_EDITOR_CONTENT, {
          conversationId,
          requestId,
          onResult: result => {
            this.postCopilotMessageResult(event, message.event, {
              requestId,
              ...result,
            });
          },
        });
        return;
      }

      const draft = String(message.data?.draft || '').trim();
      if (!draft) {
        this.postCopilotMessageResult(event, message.event, {
          ok: false,
          requestId,
        });
        return;
      }

      emitter.emit(BUS_EVENTS.REPLACE_REPLY_EDITOR_CONTENT, {
        content: draft,
        conversationId,
        policy: message.data?.policy || 'manual',
        requestId,
        onResult: result => {
          this.postCopilotMessageResult(event, message.event, {
            requestId,
            ...result,
          });
        },
      });
    },
    getFrameId(index) {
      return `dashboard-app--frame-${this.position}-${index}`;
    },
    parseDashboardAppMessage(data) {
      if (typeof data === 'object') return data;
      try {
        return JSON.parse(data);
      } catch {
        return null;
      }
    },
    findTrustedFrame(event) {
      return this.config.find((configItem, index) => {
        if (configItem.type !== 'frame' || !configItem.url) return false;

        const frameElement = document.getElementById(this.getFrameId(index));
        if (frameElement?.contentWindow !== event.source) return false;

        try {
          const expectedOrigin = new URL(
            configItem.url,
            window.location.origin
          ).origin;
          return expectedOrigin === event.origin;
        } catch {
          return false;
        }
      });
    },
    postCopilotMessageResult(event, sourceEvent, result) {
      const targetOrigin =
        event.origin && event.origin !== 'null' ? event.origin : '*';
      const resultEvent =
        sourceEvent === 'kr-copilot:get-reply-editor-content'
          ? 'kr-copilot:get-reply-editor-content-result'
          : 'kr-copilot:insert-reply-result';
      event.source?.postMessage(
        JSON.stringify({
          event: resultEvent,
          data: result,
        }),
        targetOrigin
      );
    },
    onIframeLoad(index) {
      // A possible alternative is to use ref instead of document.getElementById
      // However, when ref is used together with v-for, the ref you get will be
      // an array containing the child components mirroring the data source.
      const frameElement = document.getElementById(this.getFrameId(index));
      this.postContextToFrame(frameElement);
      this.iframeLoading = false;
    },
    postContextToFrames() {
      this.$nextTick(() => {
        this.config.forEach((configItem, index) => {
          if (configItem.type !== 'frame' || !configItem.url) return;
          const frameElement = document.getElementById(this.getFrameId(index));
          this.postContextToFrame(frameElement);
        });
      });
    },
    postContextToFrame(frameElement) {
      if (!frameElement?.contentWindow) return;
      const eventData = { event: 'appContext', data: this.dashboardAppContext };
      frameElement.contentWindow.postMessage(JSON.stringify(eventData), '*');
    },
    isCurrentConversation(conversationId) {
      if (!conversationId) return true;
      const currentIds = [
        this.currentChat?.id,
        this.currentChat?.display_id,
      ].filter(Boolean);
      return currentIds.some(id => String(id) === String(conversationId));
    },
    frameUrl(configItem) {
      if (!configItem.url || this.mode !== 'sidebar') return configItem.url;

      try {
        const url = new URL(configItem.url, window.location.origin);
        url.searchParams.set('layout', 'sidebar');
        return url.toString();
      } catch {
        return configItem.url;
      }
    },
  },
};
</script>

<!-- eslint-disable-next-line vue/no-root-v-if -->
<template>
  <div
    v-if="hasOpenedAtleastOnce"
    class="dashboard-app--container"
    :class="{ 'dashboard-app--container-sidebar': mode === 'sidebar' }"
  >
    <div
      v-for="(configItem, index) in config"
      :key="index"
      class="dashboard-app--list"
    >
      <LoadingState
        v-if="iframeLoading"
        :message="$t('DASHBOARD_APPS.LOADING_MESSAGE')"
        class="dashboard-app_loading-container"
      />
      <iframe
        v-if="configItem.type === 'frame' && configItem.url"
        :id="getFrameId(index)"
        :src="frameUrl(configItem)"
        allow="clipboard-write"
        @load="() => onIframeLoad(index)"
      />
    </div>
  </div>
</template>

<style scoped>
.dashboard-app--container,
.dashboard-app--list,
.dashboard-app--list iframe {
  height: 100%;
  width: 100%;
}

.dashboard-app--list iframe {
  border: 0;
}
.dashboard-app_loading-container {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  width: 100%;
}

.dashboard-app--container-sidebar {
  flex: 0 0 380px;
  min-width: 320px;
  max-width: 420px;
  width: 380px;
  background: rgb(var(--color-surface-1));
}
</style>
