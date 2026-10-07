import { useAtomValue } from "@effect/atom-react";
import { projectedSubagentsToRuntime } from "@t3tools/client-runtime/state/subagentRuntime";
import type { ThreadTurnSubagents } from "@t3tools/client-runtime/state/thread-subagents";
import {
  deriveAgentPanelModel,
  type AgentPanelModel,
} from "@t3tools/client-runtime/state/workflow-groups";
import type { EnvironmentId, OrchestrationV2Subagent, ThreadId } from "@t3tools/contracts";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { useMemo } from "react";
import { Platform, ScrollView, View } from "react-native";
import { Screen, ScreenStack, ScreenStackHeaderConfig } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { environmentThreadDetails } from "../../state/threads";
import { nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { AgentSheetRow } from "./AgentSheetRow";
import { WorkflowCard } from "./WorkflowCard";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

type AgentsTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

/** The turn's own roster, without the thread-wide workflow grouping. */
export function useThreadTurnSubagents(target: AgentsTarget): ThreadTurnSubagents | null {
  return useAtomValue(environmentThreadDetails.turnSubagentsAtom(target));
}

export interface ThreadAgentPanel {
  /**
   * Thread-level workflow cards, with direct spawns scoped to the current
   * turn. A workflow run outlives the turn that launched it; a direct spawn
   * does not.
   */
  readonly model: AgentPanelModel;
  /** Member rows need the contract entity the model only identifies by id. */
  readonly subagentById: ReadonlyMap<string, OrchestrationV2Subagent>;
}

export function useThreadAgentPanel(target: AgentsTarget): ThreadAgentPanel {
  const turn = useThreadTurnSubagents(target);
  // Workflow grouping runs over the whole thread roster, not the run-scoped
  // turn roster: workflow rows carry the `workflow` block and
  // `deriveThreadTurnSubagents` leaves them out. Direct spawns are scoped to
  // the current turn instead, so an old turn's rows never resurface.
  const subagents = useAtomValue(
    environmentThreadDetails.threadAtom(target),
    (thread) => thread?.projection.subagents,
  );
  return useMemo(() => {
    const roster = subagents ?? [];
    return {
      model: deriveAgentPanelModel(
        projectedSubagentsToRuntime(roster),
        projectedSubagentsToRuntime(turn?.subagents ?? []),
      ),
      subagentById: new Map(roster.map((subagent) => [subagent.id, subagent])),
    };
  }, [subagents, turn]);
}

export function ThreadAgentsSheet({ route }: StaticScreenProps<AgentsTarget>) {
  const target = route.params;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const theme = useUniwindTheme();
  const { model, subagentById } = useThreadAgentPanel(target);
  const hasLiveAgent = model.liveCount > 0;

  const openChildThread = (childThreadId: ThreadId) => {
    void Haptics.selectionAsync();
    // Replace rather than push: the sheet is a leaf, and the child thread
    // belongs in the workspace stack where Home's back button expects it.
    navigation.dispatch(
      StackActions.replace("Thread", {
        environmentId: target.environmentId,
        threadId: childThreadId,
      }),
    );
  };

  const content = (
    <ScrollView
      className="flex-1"
      // The iOS header is translucent and floats over this view; UIKit has to
      // inset the content or the first row sits underneath the title.
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      contentContainerClassName="px-5 pb-6"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
    >
      {!model.hasAgents ? (
        <Text className="pt-6 text-center text-sm text-foreground-muted">
          No agents in this turn.
        </Text>
      ) : (
        <>
          {model.workflows.map((group) => (
            <WorkflowCard
              key={group.workflow.id}
              group={group}
              subagentById={subagentById}
              environmentId={target.environmentId}
              tickSeconds={hasLiveAgent}
              onOpen={openChildThread}
            />
          ))}
          {model.workflows.length > 0 && model.directAgents.length > 0 ? (
            <Text className="px-1 pb-1 pt-2 text-2xs font-t3-medium uppercase tracking-wide text-foreground-muted">
              Direct spawns
            </Text>
          ) : null}
          {model.directAgents.map((agent) => {
            const subagent = subagentById.get(agent.id);
            // Silent degradation: a member the roster dropped renders nothing.
            if (subagent === undefined) return null;
            return (
              <AgentSheetRow
                key={agent.id}
                environmentId={target.environmentId}
                subagent={subagent}
                tickSeconds={hasLiveAgent}
                onOpen={openChildThread}
              />
            );
          })}
        </>
      )}
    </ScrollView>
  );

  if (Platform.OS === "ios") {
    // A plain formSheet screen never renders a stack header, so it comes from
    // a nested native stack inside the sheet (same shape as the git sheet).
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <Screen
            activityState={2}
            enabled
            isNativeStack
            screenId="thread-agents-sheet-native"
            scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
            style={{ backgroundColor: theme["--color-sheet"], flex: 1 }}
          >
            {content}
            <ScreenStackHeaderConfig
              backgroundColor="rgba(0,0,0,0)"
              color={theme["--color-foreground"]}
              hideBackButton
              hideShadow={false}
              title="Agents"
              titleColor={theme["--color-foreground"]}
              titleFontSize={18}
              titleFontWeight="800"
              translucent
            />
          </Screen>
        </ScreenStack>
      </View>
    );
  }

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <AndroidSheetHeader title="Agents" onBack={() => navigation.goBack()} />
      {content}
    </View>
  );
}
