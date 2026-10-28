@AbapCatalog.viewEnhancementCategory: [#NONE]
@AccessControl.authorizationCheck: #CHECK
@EndUserText.label: 'Purchase requisition'
define view entity I_PurchaseRequisition
  as select from I_PurchaseRequisitionItem
    left outer join EBAN on EBAN.banfn = I_PurchaseRequisitionItem.PurchaseRequisition
{
  key I_PurchaseRequisitionItem.PurchaseRequisition,
  key I_PurchaseRequisitionItem.PurchaseRequisitionItem,
  EBAN.badat as RequisitionDate
}
