import React, { useCallback, useEffect, useState, useMemo } from 'react'
import PropTypes from 'prop-types'
import config from '_/plugin-config'
import getPluginApi from '_/plugin-api'
import { webadminToastTypes } from '_/constants'
import { msg } from '_/intl-messages'
import { randomId } from '_/utils/random'
import { engineGet, enginePost } from '_/utils/fetch'
import { resultAfterSleep } from '_/utils/fake-data'
import { useDataProvider } from '_/components/helper/DataProviderHook'

function randomVms (vmCount) {
  return Array.from(Array(vmCount), (element, index) => ({
    id: randomId(),
    name: `random-vm-${index}`,
    host: { id: 'foo123' },
  }))
}

const fetchVmsFakeData = {
  vm: [
    // VM with a host => this VM is running on that host
    { id: 'abc123', name: 'test-vm-1', host: { id: 'xyz789' } },
    // VM without a host => this VM is not running
    { id: 'def456', name: 'test-vm-2' },
    // add some more randomly generated VMs
    ...randomVms(20),
  ],
}

const fetchTargetHostsFakeData = (function* () {
  const firstResponse = {
    host: [
      { id: 'xyz789', name: 'test-host-1' },
      { id: 'foo123', name: 'test-host-2' },
      { id: 'bar456', name: 'test-host-3' },
    ],
  }
  const secondResponse = {}
  while (true) {
    yield secondResponse
    yield firstResponse
  }
})()

/**
 * Fetch Engine VMs based on their IDs.
 */
async function fetchVms (vmIds) {
  const json = config.useFakeData
    ? await resultAfterSleep(fetchVmsFakeData)
    : await engineGet(`api/vms/?search=id=${vmIds.join(' OR id=')}`)

  if (!json || !Array.isArray(json.vm)) {
    throw new Error('VmMigrateDataProvider: Failed to fetch VMs')
  }

  return json.vm
}

/**
 * Resolve migration target hosts for the given VMs.
 */
async function fetchTargetHosts (vms, checkVmAffinity) {
  if (!vms) {
    return []
  }
  let currentHostIds = vms
    .filter(vm => vm.host && vm.host.id)
    .map(vm => vm.host.id)

  // remove duplicate values
  currentHostIds = [...new Set(currentHostIds)]

  const json = (config.useFakeData && fetchTargetHostsFakeData.next().value) ||
    await engineGet(`api/hosts?check_vms_in_affinity_closure=${!!checkVmAffinity}&migration_target_of=${vms.map(vm => vm.id).join(',')}`)

  // API returns either:
  // { host: [...]} OR
  // {} (empty object) when there are no host available
  // treat other payload as error
  if (!json || (json && json.host && !Array.isArray(json.host))) {
    throw new Error('VmMigrateDataProvider: Failed to fetch target hosts')
  }

  const targetHosts = json.host || []

  // If all VMs are currently running on the same host (currentHostIds.length === 1),
  // this particular host cannot be used as a migration target to any of the selected
  // VMs (since those VMs are already running on it). Otherwise, don't filter target
  // hosts, since each of them is a potential migration target to each of the VMs.
  const res = (currentHostIds.length === 1)
    ? targetHosts.filter(host => !currentHostIds.includes(host.id))
    : targetHosts
  return res
}

/**
 * Verify the selected target host is still a valid migration target for the
 * given VMs by re-fetching the eligible hosts from the engine. Returns the
 * fresh list of target hosts.
 */
async function verifyTargetHost (targetHostId, vms, checkVmAffinity) {
  return await fetchTargetHosts(vms, checkVmAffinity)
    .then(targetHosts =>
      // "Automatically Choose Host" is always valid, otherwise the target
      // must be in the fresh list of eligible hosts
      !targetHostId || targetHosts.some(host => host.id === targetHostId)
    )
}

/**
 * Post the migrate request for a single VM and wait for the engine's response.
 * Rejections carry the engine's `EngineError` (or network error) to the caller.
 */
function migrateSingleVm (vmId, requestBody) {
  return enginePost(`api/vms/${vmId}/migrate`, JSON.stringify(requestBody))
}

/**
 * Migrate VMs to the target host.
 *
 * Verifies the target host is still valid before posting the migration, so
 * a stale host list can't silently skip or fail VMs. Waits for every migrate
 * POST to settle: resolves only when all VMs were accepted by the engine,
 * rejects otherwise with the per-VM failures attached (`error.failures`,
 * array of `{ vmId, error }`). The caller should keep the modal open and
 * show a toast on rejection.
 */
async function migrateToHost (targetHostId, migrateVmsInAffinity, checkVmAffinity, vms) {
  const requestBody = { force: true }

  if (targetHostId) {
    requestBody.host = { id: targetHostId }
  }
  if (migrateVmsInAffinity) {
    requestBody.migrate_vms_in_affinity_closure = true
  }

  if (config.useFakeData) {
    getPluginApi().showToast(webadminToastTypes.info, 'Using fake data, nothing to migrate.')
    console.info('migrateToHost, requestBody:', requestBody)
    return
  }

  // re-check that the picked host is still an eligible migration target
  // (the host list may be stale, e.g. host went down while the dialog was open)
  const isTargetStillValid = await verifyTargetHost(targetHostId, vms, checkVmAffinity)
  if (!isTargetStillValid) {
    const error = new Error('VmMigrateDataProvider: target host is no longer a valid migration target')
    error.isStaleTarget = true
    throw error
  }

  // fire all migrate requests concurrently and wait for each to settle, so
  // HTTP errors (e.g. 409 cannot migrate, 401 expired session) are surfaced
  // instead of silently dropped
  const targets = vms.filter(vm => !vm.host || vm.host.id !== targetHostId)
  const settled = await Promise.allSettled(
    targets.map(vm => migrateSingleVm(vm.id, requestBody))
  )

  const failures = settled
    .map((result, index) =>
      result.status === 'rejected'
        ? { vmId: targets[index].id, error: result.reason }
        : null
    )
    .filter(Boolean)

  if (failures.length > 0) {
    const error = new Error(
      `VmMigrateDataProvider: ${failures.length} of ${targets.length} migrate request(s) failed`
    )
    error.failures = failures
    throw error
  }
}

export function useVmMigrateDataProvider (checkVmAffinity, vmIds) {
  const memoIds = useMemo(() => ([vmIds]), [vmIds])
  const [retryCount, setRetryCount] = useState(0)
  const retry = useCallback(() => setRetryCount(count => count + 1), [])

  const vms = useDataProvider({ fetchData: fetchVms, parameters: memoIds, trigger: retryCount })
  const hosts = useDataProvider({ fetchData: fetchTargetHosts, parameters: [vms.data, false], trigger: `${checkVmAffinity}-${retryCount}` })
  const hostsWithAffinity = useDataProvider({ fetchData: fetchTargetHosts, parameters: [vms.data, true], trigger: `${checkVmAffinity}-${retryCount}` })

  const fetchError =
    vms.fetchError || (checkVmAffinity ? hostsWithAffinity.fetchError : hosts.fetchError)
  const fetchInProgress =
    vms.fetchInProgress || (checkVmAffinity ? hostsWithAffinity.fetchInProgress : hosts.fetchInProgress)

  const targetHosts = checkVmAffinity ? hostsWithAffinity.data : hosts.data
  const dataLoaded = !!vms.data && !!targetHosts

  const suggestAffinity = !hostsWithAffinity.fetchError && !hosts.fetchError &&
    !!hosts.data && !!hostsWithAffinity.data &&
    !hosts.data.length && !!hostsWithAffinity.data.length

  return useMemo(() => ({
    vms: vms.data,
    vmsFetchError: vms.fetchError,
    vmNames: !vms.data ? [] : vms.data.map(vm => vm.name),
    targetHostItems: !targetHosts ? [] : targetHosts.map(host => ({ value: host.id, text: host.name })),
    suggestAffinity,
    dataLoaded,
    fetchError,
    fetchInProgress,
    retry,
  }), [
    vms.data,
    vms.fetchError,
    suggestAffinity,
    dataLoaded,
    fetchError,
    fetchInProgress,
    retry,
    targetHosts,
  ])
}

const withTargetHosts = (WrappedComponent) => {
  const EnhancedComponent = ({ vmIds, ...otherProps }) => {
    const [checkVmAffinity, setCheckVmAffinity] = useState(false)

    const {
      vms,
      vmsFetchError,
      vmNames,
      targetHostItems,
      suggestAffinity,
      dataLoaded,
      fetchError,
      fetchInProgress,
      retry,
    } = useVmMigrateDataProvider(checkVmAffinity, vmIds)

    useEffect(() => {
      if (!fetchError) {
        return
      }
      // distinguish which fetch failed so the user gets an actionable message
      const toastMessage =
        vmsFetchError
          ? msg.migrateVmVmsFetchError()
          : msg.migrateVmHostsFetchError()
      getPluginApi().showToast(webadminToastTypes.danger, toastMessage)
    }, [fetchError, vmsFetchError])

    if (fetchError) {
      return (
        <WrappedComponent
          {...otherProps}
          isLoading={fetchInProgress}
          fetchErrorMessage={vmsFetchError
            ? msg.migrateVmVmsFetchError()
            : msg.migrateVmHostsFetchError()}
          onRetry={retry}
          vmNames={[]}
          targetHostItems={[]}
          suggestAffinity={false}
          checkVmAffinity={checkVmAffinity}
          onRefreshHosts={(checkVmAffinity) => setCheckVmAffinity(checkVmAffinity)}
          onMigrateToHost={() => Promise.resolve(false)}
        />
      )
    }

    const handleMigrateToHost = async (hostId, migrateVmsInAffinity) => {
      try {
        await migrateToHost(hostId, migrateVmsInAffinity, checkVmAffinity, vms)
      } catch (error) {
        console.error('Failed to migrate VMs:', error)
        let toastMessage
        if (error.isStaleTarget) {
          toastMessage = msg.migrateVmHostNoLongerAvailable()
        } else if (error.failures) {
          // engine rejected one or more migrate POSTs; show a single toast
          // with the count and names of the VMs that failed, then rethrow
          // so the shared toast below is skipped
          const failedVmNames = error.failures
            .map(({ vmId }) => {
              const vm = vms.find(candidate => candidate.id === vmId)
              return vm ? vm.name : vmId
            })
          getPluginApi().showToast(webadminToastTypes.danger, msg.migrateVmPartialFailure({
            value: error.failures.length,
            total: vms.length,
            vmList: failedVmNames.join(', '),
          }))
          error.failures.forEach(({ vmId, error: failure }) => {
            console.error(`Migrate request for VM ${vmId} failed:`, failure)
          })
          throw error
        } else {
          toastMessage = msg.migrateVmValidationError()
        }
        getPluginApi().showToast(webadminToastTypes.danger, toastMessage)
        // rethrow so the modal stays open
        throw error
      }
    }

    return (
      <WrappedComponent
        {...otherProps}
        isLoading={!dataLoaded}
        suggestAffinity={suggestAffinity}
        targetHostItems={targetHostItems}
        vmNames={vmNames}
        checkVmAffinity={checkVmAffinity}
        onRefreshHosts={(checkVmAffinity) => setCheckVmAffinity(checkVmAffinity)}
        onMigrateToHost={(hostId, migrateVmsInAffinity) =>
          // the modal always closes once "Migrate" is clicked; any failure is
          // reported to the user via a toast above
          handleMigrateToHost(hostId, migrateVmsInAffinity).catch(error => {
            console.error('Failed to migrate VMs:', error)
            return true
          })}
      />
    )
  }
  EnhancedComponent.propTypes = {
    vmIds: PropTypes.arrayOf(PropTypes.string).isRequired,
  }
  return EnhancedComponent
}

export default withTargetHosts
