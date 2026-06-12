<script>
import { mapGetters } from 'vuex';
import ConversationHeader from './ConversationHeader.vue';
import DashboardAppFrame from '../DashboardApp/Frame.vue';
import EmptyState from './EmptyState/EmptyState.vue';
import MessagesView from './MessagesView.vue';

export default {
  components: {
    ConversationHeader,
    DashboardAppFrame,
    EmptyState,
    MessagesView,
  },
  props: {
    inboxId: {
      type: [Number, String],
      default: '',
      required: false,
    },
    isInboxView: {
      type: Boolean,
      default: false,
    },
    isContactPanelOpen: {
      type: Boolean,
      default: true,
    },
    isOnExpandedLayout: {
      type: Boolean,
      default: true,
    },
  },
  data() {
    return { activeIndex: 0 };
  },
  computed: {
    ...mapGetters({
      currentChat: 'getSelectedChat',
      dashboardApps: 'dashboardApps/getRecords',
    }),
    regularDashboardApps() {
      return this.dashboardApps.filter(
        dashboardApp => !this.isKrCopilotDashboardApp(dashboardApp)
      );
    },
    krCopilotDashboardApp() {
      return this.dashboardApps.find(this.isKrCopilotDashboardApp);
    },
    dashboardAppTabs() {
      return [
        {
          key: 'messages',
          index: 0,
          name: this.$t('CONVERSATION.DASHBOARD_APP_TAB_MESSAGES'),
        },
        ...this.regularDashboardApps.map((dashboardApp, index) => ({
          key: `dashboard-${dashboardApp.id}`,
          index: index + 1,
          name: dashboardApp.title,
        })),
      ];
    },
    showContactPanel() {
      return this.isContactPanelOpen && this.currentChat.id;
    },
  },
  watch: {
    'currentChat.inbox_id': {
      immediate: true,
      handler(inboxId) {
        if (inboxId) {
          this.$store.dispatch('inboxAssignableAgents/fetch', [inboxId]);
        }
      },
    },
    'currentChat.id'() {
      this.fetchLabels();
      this.activeIndex = 0;
    },
  },
  mounted() {
    this.fetchLabels();
    this.$store.dispatch('dashboardApps/get');
  },
  methods: {
    fetchLabels() {
      if (!this.currentChat.id) {
        return;
      }
      this.$store.dispatch('conversationLabels/get', this.currentChat.id);
    },
    onDashboardAppTabChange(index) {
      this.activeIndex = index;
    },
    isKrCopilotDashboardApp(dashboardApp = {}) {
      if (dashboardApp.title === 'KR Copilot') return true;
      const content = Array.isArray(dashboardApp.content)
        ? dashboardApp.content
        : [];
      return content.some(configItem => {
        return String(configItem?.url || '').includes('kits-support-copilot');
      });
    },
  },
};
</script>

<template>
  <div
    class="conversation-details-wrap flex flex-col min-w-0 w-full bg-n-surface-1 relative"
    :class="{
      'border-l rtl:border-l-0 rtl:border-r border-n-weak': !isOnExpandedLayout,
    }"
  >
    <ConversationHeader
      v-if="currentChat.id"
      :chat="currentChat"
      :show-back-button="isOnExpandedLayout && !isInboxView"
      :class="{
        'border-b border-b-n-weak !pt-2': !regularDashboardApps.length,
      }"
    />
    <woot-tabs
      v-if="regularDashboardApps.length && currentChat.id"
      :index="activeIndex"
      class="h-10"
      @change="onDashboardAppTabChange"
    >
      <woot-tabs-item
        v-for="tab in dashboardAppTabs"
        :key="tab.key"
        :index="tab.index"
        :name="tab.name"
        :show-badge="false"
        is-compact
      />
    </woot-tabs>
    <div class="flex h-full min-h-0 m-0">
      <div class="flex flex-col flex-1 min-w-0">
        <div v-show="!activeIndex" class="flex h-full min-h-0 m-0">
          <MessagesView
            v-if="currentChat.id"
            :inbox-id="inboxId"
            :is-inbox-view="isInboxView"
          />
          <EmptyState
            v-if="!currentChat.id && !isInboxView"
            :is-on-expanded-layout="isOnExpandedLayout"
          />
          <slot />
        </div>
        <DashboardAppFrame
          v-for="(dashboardApp, index) in regularDashboardApps"
          v-show="activeIndex - 1 === index"
          :key="currentChat.id + '-' + dashboardApp.id"
          :is-visible="activeIndex - 1 === index"
          :config="dashboardApp.content"
          :position="index"
          :current-chat="currentChat"
        />
      </div>
      <DashboardAppFrame
        v-if="krCopilotDashboardApp && currentChat.id"
        :key="currentChat.id + '-' + krCopilotDashboardApp.id + '-sidebar'"
        class="hidden xl:flex w-[380px] min-w-[320px] max-w-[420px] border-l border-n-weak"
        mode="sidebar"
        :is-visible="true"
        :config="krCopilotDashboardApp.content"
        :position="9000"
        :current-chat="currentChat"
      />
    </div>
  </div>
</template>
