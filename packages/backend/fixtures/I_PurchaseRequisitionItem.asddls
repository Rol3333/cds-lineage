@AbapCatalog.viewEnhancementCategory: [#NONE]
@AccessControl.authorizationCheck: #CHECK
@EndUserText.label: 'Purchase requisition item'
define view entity I_PurchaseRequisitionItem
  as select from I_PurchaseRequisitionAccountAssignment
    left outer join EKPO on EKPO.ebeln = I_PurchaseRequisitionAccountAssignment.PurchaseRequisition
{
  key I_PurchaseRequisitionAccountAssignment.PurchaseRequisition,
  key I_PurchaseRequisitionAccountAssignment.PurchaseRequisitionItem
}
