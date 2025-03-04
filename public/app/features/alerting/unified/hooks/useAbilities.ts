import { useMemo } from 'react';

import { contextSrv as ctx } from 'app/core/services/context_srv';
import { AlertmanagerChoice } from 'app/plugins/datasource/alertmanager/types';
import { AccessControlAction } from 'app/types';
import { CombinedRule, RulesSource } from 'app/types/unified-alerting';

import { alertmanagerApi } from '../api/alertmanagerApi';
import { useAlertmanager } from '../state/AlertmanagerContext';
import { getInstancesPermissions, getNotificationsPermissions, getRulesPermissions } from '../utils/access-control';
import { GRAFANA_RULES_SOURCE_NAME } from '../utils/datasource';
import { isFederatedRuleGroup, isGrafanaRulerRule } from '../utils/rules';

import { useIsRuleEditable } from './useIsRuleEditable';

/**
 * These hooks will determine if
 *  1. the action is supported in the current context (alertmanager, alert rule or general context)
 *  2. user is allowed to perform actions based on their set of permissions / assigned role
 */

// this enum lists all of the available actions we can perform within the context of an alertmanager
export enum AlertmanagerAction {
  // configuration
  ViewExternalConfiguration = 'view-external-configuration',
  UpdateExternalConfiguration = 'update-external-configuration',

  // contact points
  CreateContactPoint = 'create-contact-point',
  ViewContactPoint = 'view-contact-point',
  UpdateContactPoint = 'edit-contact-points',
  DeleteContactPoint = 'delete-contact-point',
  ExportContactPoint = 'export-contact-point',

  // notification templates
  CreateNotificationTemplate = 'create-notification-template',
  ViewNotificationTemplate = 'view-notification-template',
  UpdateNotificationTemplate = 'edit-notification-template',
  DeleteNotificationTemplate = 'delete-notification-template',
  DecryptSecrets = 'decrypt-secrets',

  // notification policies
  CreateNotificationPolicy = 'create-notification-policy',
  ViewNotificationPolicyTree = 'view-notification-policy-tree',
  UpdateNotificationPolicyTree = 'update-notification-policy-tree',
  DeleteNotificationPolicy = 'delete-notification-policy',
  ExportNotificationPolicies = 'export-notification-policies',

  // silences – these cannot be deleted only "expired" (updated)
  CreateSilence = 'create-silence',
  ViewSilence = 'view-silence',
  UpdateSilence = 'update-silence',

  // mute timings
  ViewMuteTiming = 'view-mute-timing',
  CreateMuteTiming = 'create-mute-timing',
  UpdateMuteTiming = 'update-mute-timing',
  DeleteMuteTiming = 'delete-mute-timing',
}

// this enum lists all of the available actions we can take on a single alert rule
export enum AlertRuleAction {
  Duplicate = 'duplicate-alert-rule',
  View = 'view-alert-rule',
  Update = 'update-alert-rule',
  Delete = 'delete-alert-rule',
  Explore = 'explore-alert-rule',
  Silence = 'silence-alert-rule',
  ModifyExport = 'modify-export-rule',
}

// this enum lists all of the actions we can perform within alerting in general, not linked to a specific
// alert source, rule or alertmanager
export enum AlertingAction {
  // internal (Grafana managed)
  CreateAlertRule = 'create-alert-rule',
  ViewAlertRule = 'view-alert-rule',
  UpdateAlertRule = 'update-alert-rule',
  DeleteAlertRule = 'delete-alert-rule',
  ExportGrafanaManagedRules = 'export-grafana-managed-rules',

  // external (any compatible alerting data source)
  CreateExternalAlertRule = 'create-external-alert-rule',
  ViewExternalAlertRule = 'view-external-alert-rule',
  UpdateExternalAlertRule = 'update-external-alert-rule',
  DeleteExternalAlertRule = 'delete-external-alert-rule',
}

// these just makes it easier to read the code :)
const AlwaysSupported = true;
const NotSupported = false;

export type Action = AlertmanagerAction | AlertingAction | AlertRuleAction;
export type Ability = [actionSupported: boolean, actionAllowed: boolean];
export type Abilities<T extends Action> = Record<T, Ability>;

/**
 * This one will check for alerting abilities that don't apply to any particular alert source or alert rule
 */
export const useAlertingAbilities = (): Abilities<AlertingAction> => {
  return {
    // internal (Grafana managed)
    [AlertingAction.CreateAlertRule]: toAbility(AlwaysSupported, AccessControlAction.AlertingRuleCreate),
    [AlertingAction.ViewAlertRule]: toAbility(AlwaysSupported, AccessControlAction.AlertingRuleRead),
    [AlertingAction.UpdateAlertRule]: toAbility(AlwaysSupported, AccessControlAction.AlertingRuleUpdate),
    [AlertingAction.DeleteAlertRule]: toAbility(AlwaysSupported, AccessControlAction.AlertingRuleDelete),
    [AlertingAction.ExportGrafanaManagedRules]: toAbility(AlwaysSupported, AccessControlAction.AlertingRuleRead),

    // external
    [AlertingAction.CreateExternalAlertRule]: toAbility(AlwaysSupported, AccessControlAction.AlertingRuleExternalWrite),
    [AlertingAction.ViewExternalAlertRule]: toAbility(AlwaysSupported, AccessControlAction.AlertingRuleExternalRead),
    [AlertingAction.UpdateExternalAlertRule]: toAbility(AlwaysSupported, AccessControlAction.AlertingRuleExternalWrite),
    [AlertingAction.DeleteExternalAlertRule]: toAbility(AlwaysSupported, AccessControlAction.AlertingRuleExternalWrite),
  };
};

export const useAlertingAbility = (action: AlertingAction): Ability => {
  const allAbilities = useAlertingAbilities();
  return allAbilities[action];
};

/**
 * This hook will check if we support the action and have sufficient permissions for it on a single alert rule
 */
export function useAlertRuleAbility(rule: CombinedRule, action: AlertRuleAction): Ability {
  const abilities = useAllAlertRuleAbilities(rule);

  return useMemo(() => {
    return abilities[action];
  }, [abilities, action]);
}

export function useAlertRuleAbilities(rule: CombinedRule, actions: AlertRuleAction[]): Ability[] {
  const abilities = useAllAlertRuleAbilities(rule);

  return useMemo(() => {
    return actions.map((action) => abilities[action]);
  }, [abilities, actions]);
}

export function useAllAlertRuleAbilities(rule: CombinedRule): Abilities<AlertRuleAction> {
  const rulesSource = rule.namespace.rulesSource;
  const rulesSourceName = typeof rulesSource === 'string' ? rulesSource : rulesSource.name;

  const isProvisioned = isGrafanaRulerRule(rule.rulerRule) && Boolean(rule.rulerRule.grafana_alert.provenance);
  const isFederated = isFederatedRuleGroup(rule.group);

  // if a rule is either provisioned or a federated rule, we don't allow it to be removed or edited
  const immutableRule = isProvisioned || isFederated;

  // TODO refactor this hook maybe
  const {
    isEditable,
    isRemovable,
    isRulerAvailable = false,
    loading,
  } = useIsRuleEditable(rulesSourceName, rule.rulerRule);
  const [_, exportAllowed] = useAlertingAbility(AlertingAction.ExportGrafanaManagedRules);

  // while we gather info, pretend it's not supported
  const MaybeSupported = loading ? NotSupported : isRulerAvailable;
  const MaybeSupportedUnlessImmutable = immutableRule ? NotSupported : MaybeSupported;

  const rulesPermissions = getRulesPermissions(rulesSourceName);
  const canSilence = useCanSilence(rulesSource);

  const abilities: Abilities<AlertRuleAction> = {
    [AlertRuleAction.Duplicate]: toAbility(MaybeSupported, rulesPermissions.create),
    [AlertRuleAction.View]: toAbility(AlwaysSupported, rulesPermissions.read),
    [AlertRuleAction.Update]: [MaybeSupportedUnlessImmutable, isEditable ?? false],
    [AlertRuleAction.Delete]: [MaybeSupportedUnlessImmutable, isRemovable ?? false],
    [AlertRuleAction.Explore]: toAbility(AlwaysSupported, AccessControlAction.DataSourcesExplore),
    [AlertRuleAction.Silence]: canSilence,
    [AlertRuleAction.ModifyExport]: [MaybeSupported, exportAllowed],
  };

  return abilities;
}

export function useAllAlertmanagerAbilities(): Abilities<AlertmanagerAction> {
  const {
    selectedAlertmanager,
    hasConfigurationAPI,
    isGrafanaAlertmanager: isGrafanaFlavoredAlertmanager,
  } = useAlertmanager();

  // These are used for interacting with Alertmanager resources where we apply alert.notifications:<name> permissions.
  // There are different permissions based on wether the built-in alertmanager is selected (grafana) or an external one.
  const notificationsPermissions = getNotificationsPermissions(selectedAlertmanager!);
  const instancePermissions = getInstancesPermissions(selectedAlertmanager!);

  // list out all of the abilities, and if the user has permissions to perform them
  const abilities: Abilities<AlertmanagerAction> = {
    // -- configuration --
    [AlertmanagerAction.ViewExternalConfiguration]: toAbility(
      AlwaysSupported,
      AccessControlAction.AlertingNotificationsExternalRead
    ),
    [AlertmanagerAction.UpdateExternalConfiguration]: toAbility(
      hasConfigurationAPI,
      AccessControlAction.AlertingNotificationsExternalWrite
    ),
    // -- contact points --
    [AlertmanagerAction.CreateContactPoint]: toAbility(hasConfigurationAPI, notificationsPermissions.create),
    [AlertmanagerAction.ViewContactPoint]: toAbility(AlwaysSupported, notificationsPermissions.read),
    [AlertmanagerAction.UpdateContactPoint]: toAbility(hasConfigurationAPI, notificationsPermissions.update),
    [AlertmanagerAction.DeleteContactPoint]: toAbility(hasConfigurationAPI, notificationsPermissions.delete),
    // only Grafana flavored alertmanager supports exporting
    [AlertmanagerAction.ExportContactPoint]: toAbility(isGrafanaFlavoredAlertmanager, notificationsPermissions.read),
    // -- notification templates --
    [AlertmanagerAction.CreateNotificationTemplate]: toAbility(hasConfigurationAPI, notificationsPermissions.create),
    [AlertmanagerAction.ViewNotificationTemplate]: toAbility(AlwaysSupported, notificationsPermissions.read),
    [AlertmanagerAction.UpdateNotificationTemplate]: toAbility(hasConfigurationAPI, notificationsPermissions.update),
    [AlertmanagerAction.DeleteNotificationTemplate]: toAbility(hasConfigurationAPI, notificationsPermissions.delete),
    // -- notification policies --
    [AlertmanagerAction.CreateNotificationPolicy]: toAbility(hasConfigurationAPI, notificationsPermissions.create),
    [AlertmanagerAction.ViewNotificationPolicyTree]: toAbility(AlwaysSupported, notificationsPermissions.read),
    [AlertmanagerAction.UpdateNotificationPolicyTree]: toAbility(hasConfigurationAPI, notificationsPermissions.update),
    [AlertmanagerAction.DeleteNotificationPolicy]: toAbility(hasConfigurationAPI, notificationsPermissions.delete),
    [AlertmanagerAction.ExportNotificationPolicies]: toAbility(
      isGrafanaFlavoredAlertmanager,
      notificationsPermissions.read
    ),
    [AlertmanagerAction.DecryptSecrets]: toAbility(
      isGrafanaFlavoredAlertmanager,
      notificationsPermissions.provisioning.readSecrets
    ),
    // -- silences --
    [AlertmanagerAction.CreateSilence]: toAbility(hasConfigurationAPI, instancePermissions.create),
    [AlertmanagerAction.ViewSilence]: toAbility(AlwaysSupported, instancePermissions.read),
    [AlertmanagerAction.UpdateSilence]: toAbility(hasConfigurationAPI, instancePermissions.update),
    // -- mute timtings --
    [AlertmanagerAction.CreateMuteTiming]: toAbility(hasConfigurationAPI, notificationsPermissions.create),
    [AlertmanagerAction.ViewMuteTiming]: toAbility(AlwaysSupported, notificationsPermissions.read),
    [AlertmanagerAction.UpdateMuteTiming]: toAbility(hasConfigurationAPI, notificationsPermissions.update),
    [AlertmanagerAction.DeleteMuteTiming]: toAbility(hasConfigurationAPI, notificationsPermissions.delete),
  };

  return abilities;
}

export function useAlertmanagerAbility(action: AlertmanagerAction): Ability {
  const abilities = useAllAlertmanagerAbilities();

  return useMemo(() => {
    return abilities[action];
  }, [abilities, action]);
}

export function useAlertmanagerAbilities(actions: AlertmanagerAction[]): Ability[] {
  const abilities = useAllAlertmanagerAbilities();

  return useMemo(() => {
    return actions.map((action) => abilities[action]);
  }, [abilities, actions]);
}

/**
 * We don't want to show the silence button if either
 * 1. the user has no permissions to create silences
 * 2. the admin has configured to only send instances to external AMs
 */
function useCanSilence(rulesSource: RulesSource): [boolean, boolean] {
  const isGrafanaManagedRule = rulesSource === GRAFANA_RULES_SOURCE_NAME;

  const { useGetAlertmanagerChoiceStatusQuery } = alertmanagerApi;
  const { currentData: amConfigStatus, isLoading } = useGetAlertmanagerChoiceStatusQuery(undefined, {
    skip: !isGrafanaManagedRule,
  });

  // we don't support silencing when the rule is not a Grafana managed rule
  // we simply don't know what Alertmanager the ruler is sending alerts to
  if (!isGrafanaManagedRule || isLoading) {
    return [false, false];
  }

  const interactsOnlyWithExternalAMs = amConfigStatus?.alertmanagersChoice === AlertmanagerChoice.External;
  const interactsWithAll = amConfigStatus?.alertmanagersChoice === AlertmanagerChoice.All;
  const silenceSupported = !interactsOnlyWithExternalAMs || interactsWithAll;

  return toAbility(silenceSupported, AccessControlAction.AlertingInstanceCreate);
}

// just a convenient function
const toAbility = (supported: boolean, action: AccessControlAction): Ability => [supported, ctx.hasPermission(action)];
