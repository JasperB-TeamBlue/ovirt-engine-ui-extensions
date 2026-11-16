import React, { useState } from 'react'
import PropTypes from 'prop-types'
import { msg } from '_/intl-messages'
import { autoSelectItemVal } from '_/constants'

import { Button, EmptyState, EmptyStateIcon, EmptyStateBody, EmptyStateVariant, Title } from '@patternfly/react-core'
import { ExclamationCircleIcon } from '@patternfly/react-icons'
import PluginApiModal from '_/components/modals/PluginApiModal'
import LoadingSpinner from '_/components/helper/LoadingSpinner'
import VmMigrateModalBody, { selectItemShape } from './VmMigrateModalBody'
import withTargetHosts from './VmMigrateDataProvider'

import './vm-migrate.css'

const VmMigrateModal = ({
  isLoading = false,
  fetchErrorMessage = null,
  onRetry = () => {},
  vmNames = [],
  targetHostItems = [],
  suggestAffinity = false,
  onMigrateToHost = () => {},
  onRefreshHosts = () => {},
  onClose = () => {},
}) => {
  const [isOpen, setOpen] = useState(true)
  const [hostId, setHostId] = useState(autoSelectItemVal)
  const [migrateVmsInAffinity, setMigrateVmsInAffinity] = useState(false)
  const [migrating, setMigrating] = useState(false)

  if (!isOpen) {
    return null
  }

  const close = () => {
    setOpen(false)
    onClose()
  }

  const onMigrateVmsInAffinityChange = (migrateVmsInAffinity) => {
    setMigrateVmsInAffinity(migrateVmsInAffinity)
    onRefreshHosts(migrateVmsInAffinity)
  }

  const onMigrateButtonClick = async () => {
    const hostOrNothing =
      hostId === autoSelectItemVal
        ? undefined
        : hostId

    try {
      setMigrating(true)
      // post migration (failures are reported via toast by onMigrateToHost);
      // the modal is closed either way
      await onMigrateToHost(hostOrNothing, migrateVmsInAffinity)
      close()
    } finally {
      setMigrating(false)
    }
  }

  const modalActionButtons = fetchErrorMessage
    ? [
      <Button
        key='vm-migrate-retry-button'
        ouiaId='vm-migrate-retry-button'
        variant='primary'
        onClick={onRetry}
        isDisabled={isLoading}
        isLoading={isLoading}
      >
        {msg.migrateVmRetryButton()}
      </Button>,
      <Button
        key='vm-migrate-cancel-button'
        ouiaId='vm-migrate-cancel-button'
        variant='link'
        onClick={close}
      >
        {msg.cancelButton()}
      </Button>,
    ]
    : [
      <Button
        key='vm-migrate-migrate-button'
        ouiaId='vm-migrate-migrate-button'
        variant='primary'
        onClick={onMigrateButtonClick}
        isDisabled={targetHostItems.length === 0 || migrating}
        isLoading={migrating}
      >
        {msg.migrateVmButton()}
      </Button>,
      <Button
        key='vm-migrate-cancel-button'
        ouiaId='vm-migrate-cancel-button'
        variant='link'
        onClick={close}
      >
        {msg.cancelButton()}
      </Button>,
    ]

  return (
    <PluginApiModal
      id='vm-migrate-modal'
      variant='large'
      title={msg.migrateVmDialogTitle()}
      isOpen={isOpen}
      onClose={close}
      actions={modalActionButtons}
    >
      <LoadingSpinner isLoading={isLoading}>
        {fetchErrorMessage
          ? (
            <EmptyState variant={EmptyStateVariant.small}>
              <EmptyStateIcon icon={ExclamationCircleIcon} color='#c9190b' />
              <Title headingLevel='h4' size='lg'>
                {msg.migrateVmDialogTitle()}
              </Title>
              <EmptyStateBody>{fetchErrorMessage}</EmptyStateBody>
            </EmptyState>
          )
          : (
            <VmMigrateModalBody
              vmNames={vmNames}
              migrateVmsInAffinity={migrateVmsInAffinity}
              targetHostItems={targetHostItems}
              selectedHostId={hostId}
              suggestAffinity={suggestAffinity}

              onHostSelectionChange={value => setHostId(value)}
              onMigrateVmsInAffinityChange={onMigrateVmsInAffinityChange}
            />
          )}
      </LoadingSpinner>
    </PluginApiModal>
  )
}

VmMigrateModal.propTypes = {
  // data input
  isLoading: PropTypes.bool,
  fetchErrorMessage: PropTypes.string,
  vmNames: PropTypes.arrayOf(PropTypes.string),
  targetHostItems: PropTypes.arrayOf(PropTypes.shape(selectItemShape)),
  suggestAffinity: PropTypes.bool,

  // operation callbacks
  onMigrateToHost: PropTypes.func,
  onRefreshHosts: PropTypes.func,
  onRetry: PropTypes.func,

  // modal props
  onClose: PropTypes.func,
}

export default withTargetHosts(VmMigrateModal)
