@AbapCatalog.sqlViewName: 'ZCMPRQCUBE'
@EndUserText.label: 'Purchase requisition cube'
@Analytics.dataCategory: #CUBE
define view ZC_PurReqItemCube
  as select from I_PurchaseRequisition
    left outer join T001 on T001.bukrs = I_PurchaseRequisition.CompanyCode
    left outer join MARA on MARA.matnr = I_PurchaseRequisition.Material
{
  key I_PurchaseRequisition.PurchaseRequisition,
  key I_PurchaseRequisition.PurchaseRequisitionItem,
  T001.butxt as CompanyCodeName,
  MARA.matkl as MaterialGroup
}
