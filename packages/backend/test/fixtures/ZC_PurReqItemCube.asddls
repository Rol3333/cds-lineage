@AbapCatalog.sqlViewName: 'ZCMMPREQITMCUBE'
@AbapCatalog.compiler.compareFilter: true
@AbapCatalog.preserveKey: true
@AccessControl.authorizationCheck: #CHECK
@AccessControl.personalData.blocking: #NOT_REQUIRED
@VDM.viewType: #CONSUMPTION
@ClientHandling.algorithm: #SESSION_VARIABLE
@ObjectModel.usageType.dataClass: #MIXED
@ObjectModel.usageType.serviceQuality: #D
@ObjectModel.usageType.sizeCategory:  #L
@Analytics.dataCategory: #CUBE
@Analytics.internalName:#LOCAL
@Metadata.allowExtensions:true
@ObjectModel.supportedCapabilities: [ #ANALYTICAL_PROVIDER]
@ObjectModel.modelingPattern: #ANALYTICAL_CUBE
@Metadata.ignorePropagatedAnnotations:true
@EndUserText.label: 'Purchase requisition item cube' 
define view ZC_PurReqItemCube 
    with parameters
    P_StartDate : bedat, 
    P_EndDate : bedat,
    P_DisplayCurrency : displaycurrency,
    @Environment.systemField: #SYSTEM_DATE
    @Consumption.hidden: true
    P_CurrentDate : vdm_v_key_date
    
as select from I_Purchaserequisitionitem as _Item
      
      left outer join ZI_MMPurOrdInvAmtQty    as _ZI_MMPurOrdInvAmtQty            on  _Item.PurchaseRequisition = _ZI_MMPurOrdInvAmtQty.PurchaseRequisition
                                                                                            and _Item.PurchaseRequisitionItem = _ZI_MMPurOrdInvAmtQty.PurchaseRequisitionItem
      left outer join ZP_MM_PuReq_AprDat as _PRecApprovalDate on _Item.PurchaseRequisition = _PRecApprovalDate.PurchaseRequisition  
      left outer join ZP_MM_PurReq_ClsDat as _PRecCloseDate on _Item.PurchaseRequisition = _PRecCloseDate.PurchaseRequisition
                                                                and _Item.PurchaseRequisitionItem = _PRecCloseDate.PurchaseRequisitionItem 
                                                                and _Item.IsClosed = _PRecCloseDate.IsClosed
      left outer join ZP_MM_PurReq_RegD as _PRExecStartDate on _Item.PurchaseRequisition =   _PRExecStartDate.PurchaseRequisition
                                                                and _Item.PurchaseRequisitionItem = _PRExecStartDate.PurchaseRequisitionItem 
      left outer join ZP_MM_PR_DOC_TF( mandt: $session.client, p_startdate: $parameters.P_StartDate, p_enddate: $parameters.P_EndDate)  as _PRDocList 
                                                                on _Item.PurchaseRequisition =  _PRDocList.PurchaseRequisition 
                                                                and _Item.PurchaseRequisitionItem = _PRDocList.PurchaseRequisitionItem  
        left outer join ZI_MM_UserOrgUnitDedup( p_langu : $session.system_language ) as _UserOrg
            on  _Item.CreatedByUser = _UserOrg.userId
            and _Item.CreationDate  between _UserOrg.validFrom and _UserOrg.validTo                                                                                                                                                                                        
       
       association [0..1] to ZI_MM_CMCDHDRLAST2 as _LastRelease on _LastRelease.PurchaseRequisition = _Item.PurchaseRequisition 
       association [0..1] to I_PurReqnAcctAssgmt          as _PurReqnAcctAssgmt01      on  $projection.PurchaseRequisition     = _PurReqnAcctAssgmt01.PurchaseRequisition
                                                                                and $projection.PurchaseRequisitionItem = _PurReqnAcctAssgmt01.PurchaseRequisitionItem 
                                                                                and _PurReqnAcctAssgmt01.PurchaseReqnAcctAssgmtNumber = '01'                                                                                           
       association [0..1] to I_Product                     as _Product                    on  $projection.Product = _Product.Product
       association [0..1] to I_ProductGroup_2              as _ProductGroup               on  $projection.ProductGroup = _ProductGroup.ProductGroup
       association [0..1] to I_CalendarDate                as _PRCreateDate               on  $projection.PRCreateDate = _PRCreateDate.CalendarDate
       association [0..1] to I_CalendarDate                as _PRReleaseDate              on  $projection.PRReleaseDate = _PRReleaseDate.CalendarDate
       association [0..1] to I_CalendarDate                as _PRDeliveryDate             on  $projection.PRDeliveryDate = _PRDeliveryDate.CalendarDate
       association [0..1] to I_CalendarDate                as _PRApproveDate             on  $projection.PurRecApproveDate = _PRApproveDate.CalendarDate
       association [0..1] to I_CalendarDate                as _PRCloseDate             on  $projection.CloseDate = _PRCloseDate.CalendarDate
       association [0..1] to I_CalendarDate                as _PRExStartDate            on $projection.ExecutionStartDate = _PRExStartDate.CalendarDate 
       -- association [0..1] to I_Currency                    as  _DisplayCurrency        on  $projection.DisplayCurrency = _DisplayCurrency.Currency
       association [0..1] to I_CompanyCode                 as _CompanyCode                on $projection.CompanyCode = _CompanyCode.CompanyCode    
       association [0..1] to I_PurReqnReleaseStatus         as _PRReleaseStatus           on $projection.PurReqnReleaseStatus = _PRReleaseStatus.PurReqnReleaseStatus   
       //association [0..1] to I_CostCenter                   as _CostCenter                on $projection.CostCenter   = _CostCenter.CostCenter   
       association [0..1] to E_Purchaserequisitionitem   as _PurchaseReqnItemExtension   on  _PurchaseReqnItemExtension.PurchaseRequisition     = $projection.PurchaseRequisition
                                                                                    and _PurchaseReqnItemExtension.PurchaseRequisitionItem = $projection.PurchaseRequisitionItem                                                                                       //and _CostCenter.ControllingArea is null                                                                               
      association [0..1] to I_UserContactCard as _CreatedBy on   $projection.CreatedByUser = _CreatedBy.ContactCardID
{
    key _Item.PurchaseRequisition,
    key _Item.PurchaseRequisitionItem,
    _Item.PurchasingDocument,
    _Item.PurchasingDocumentItem,
    @ObjectModel.foreignKey.association: '_PRReleaseStatus'
    _Item.PurReqnReleaseStatus,
    _PRReleaseStatus as _PRReleaseStatus,
    _Item.PurchaseRequisitionType,
    _Item.PurchasingDocumentSubtype,
    _Item.PurchasingDocumentItemCategory,
    _Item.PurchaseRequisitionItemText,
    _Item.PurchasingDocumentCategory,
    _Item.ReleaseCode,
    _Item.Language,
    _Item.IsClosed,
    _UserOrg.orgUnitName ,

    
     @Semantics.text: true
     @EndUserText.label:'Purchase Requisition Description'
     _PurchaseReqnItemExtension.zztext as  PurReqnHeaderDescription,
    
    -- Dimensions
    
  
    _Item.PurchaseRequisition as PurchaseRequisitionNumber,
    
    @ObjectModel.text.element: 'CompanyCodeName'
    @ObjectModel.foreignKey.association: '_CompanyCode'
    _Item.CompanyCode,
    _CompanyCode.CompanyCodeName as CompanyCOdeName,
    _CompanyCode as _CompanyCode,
    _CompanyCode.FinancialManagementArea,
    
    _Item.ValuationArea,
    
    @ObjectModel.foreignKey.association: '_PurchasingOrganization'
    _Item.PurchasingOrganization,
    _Item._PurchasingOrganization as _PurchasingOrganization,
    
    @ObjectModel.foreignKey.association: '_PurchasingGroup'
    _Item.PurchasingGroup,
    _Item._PurchasingGroup as _PurchasingGroup,
    
    @ObjectModel.foreignKey.association: '_Plant'
    _Item.Plant,
    _Item._Plant as _Plant,
    
    @ObjectModel.foreignKey.association: '_Product'
    _Item.Material as Product,
    _Product as _Product,
    @ObjectModel.foreignKey.association: '_ProductGroup'
    _Item.MaterialGroup as ProductGroup,
    _ProductGroup as _ProductGroup,
    
    @ObjectModel.foreignKey.association: '_AccAssgnmtCategory'
    _Item.AccountAssignmentCategory,
    _Item._AccAssgnmtCategory,
   
    _PurReqnAcctAssgmt01.CostCenter as CostCenter,
    _PurReqnAcctAssgmt01.ProfitCenter,
    _PurReqnAcctAssgmt01.WBSElementInternalID      as WBSElementInternalID,
    _PurReqnAcctAssgmt01.ProjectNetwork     as ProjectNetwork,
    
    case when  _Item.AccountAssignmentCategory = ''
     then _Item.Fund 
     else _PurReqnAcctAssgmt01.Fund
    end as Fund,
    case when  _Item.AccountAssignmentCategory = ''
     then _Item.FunctionalArea 
     else _PurReqnAcctAssgmt01.FunctionalArea 
    end as FunctionalArea,
    case when  _Item.AccountAssignmentCategory = ''
     then _Item.FundsCenter
     else _PurReqnAcctAssgmt01.FundsCenter
    end as FundsCenter,
    case when  _Item.AccountAssignmentCategory = ''
     then _PurReqnAcctAssgmt01.CommitmentItemShortID //G07-237 S4upgr this was used before but is missing _Item.CommitmentItem 
     else _PurReqnAcctAssgmt01.CommitmentItemShortID                         
    end as CommitmentItemShortID, 
    case when  _Item.AccountAssignmentCategory = ''
     then _Item.BudgetPeriod
     else _PurReqnAcctAssgmt01.BudgetPeriod 
    end as BudgetPeriod,
    
    
    _PurReqnAcctAssgmt01.MasterFixedAsset as MasterFixedAsset,
    _PurReqnAcctAssgmt01.FixedAsset    as FixedAsset,
    _PurReqnAcctAssgmt01.OrderID                  as OrderID,
    _Item.IsPurReqnBlocked,
    _Item.PurReqnItemBlockingReasonText,
    _Item.PurchaseOrderDate,
    _Item.MaterialOrderUnit,
    _Item.PurReqnExternalReference,
    _Item.PurReqnItemExternalReference,
    
    _Item.CreatedByUser,
    @EndUserText.label: 'Iniciatorius'    
    _CreatedBy.FullName as UserFullName,
    _Item.RequisitionerName,
    
    @Semantics.text: true 
    _PRDocList.documentlist as DocumentList,
    
    -- Units
    @Semantics.unitOfMeasure: true
    _Item.BaseUnit,
    @Semantics.unitOfMeasure: true
    _ZI_MMPurOrdInvAmtQty.BaseUnitOfMeasure as InvBaseUnitOfMeasure,
    
    --Currencies
    @Semantics.currencyCode: true
    _Item.PurReqnItemCurrency,
    _Item._Currency as _PurReqItemCurrency,
    @Semantics.currencyCode: true
    _ZI_MMPurOrdInvAmtQty.DocumentCurrency as InvDocCurrency,
    _ZI_MMPurOrdInvAmtQty._Currency as _InvCurrency,
    @Semantics.currencyCode: true
    $parameters.P_DisplayCurrency as DisplayCurrency,
    
    -- Dates
    
    @ObjectModel.foreignKey.association: '_PRReleaseDate'
    _Item.PurchaseRequisitionReleaseDate as PRReleaseDate,
    _PRReleaseDate as _PRReleaseDate,
 
    @ObjectModel.foreignKey.association: '_PRDeliveryDate'
    _Item.DeliveryDate as PRDeliveryDate,
    _PRDeliveryDate as _PRDeliveryDate,
    
    @ObjectModel.foreignKey.association: '_PRCreateDate'
    _Item.CreationDate as PRCreateDate,
    _PRCreateDate as _PRCreateDate,
    
    @ObjectModel.foreignKey.association: '_PRApproveDate'
    _PRecApprovalDate.MethEdate as PurRecApproveDate,
    _PRApproveDate,
       
    @ObjectModel.foreignKey.association: '_PRCloseDate'
    _PRecCloseDate.CloseDate,    
    _PRCloseDate,
    
    @ObjectModel.foreignKey.association: '_PRExStartDate'
    coalesce(_PRExecStartDate.ExecutionStartDate, _PRecApprovalDate.MethEdate) as ExecutionStartDate,
    _PRExStartDate,
    _PRExecStartDate.ExecutionStartDate as ExecStartDateOrig,
    
    -- Key Figures
 
    @DefaultAggregation: #MAX
    case when _PRecApprovalDate.MethEdate is null
            then 0
        when _PRecCloseDate.CloseDate is null
        then
            dats_days_between( _PRecApprovalDate.MethEdate , $parameters.P_CurrentDate)
        else
            dats_days_between( _PRecApprovalDate.MethEdate, _PRecCloseDate.CloseDate )
        end as ExecutionInDays,
     
     @DefaultAggregation: #MAX
     case when _PRecCloseDate.CloseDate is null
        then
            dats_days_between( _Item.DeliveryDate ,$parameters.P_CurrentDate)
        else
            dats_days_between( _Item.DeliveryDate, _PRecCloseDate.CloseDate )
        end as DelayInDays,   
    
    @Semantics.quantity.unitOfMeasure: 'BaseUnit'
    @DefaultAggregation: #SUM
    _Item.RequestedQuantity,
    @Semantics.quantity.unitOfMeasure: 'BaseUnit'
    @DefaultAggregation: #SUM
    _Item.OrderedQuantity,
    
    
    @Semantics.amount.currencyCode: 'PurReqnItemCurrency'
    @DefaultAggregation: #SUM
    _Item.PurchaseRequisitionPrice,
    @Semantics.quantity.unitOfMeasure: 'BaseUnit'
    @DefaultAggregation: #SUM
    _Item.PurReqnPriceQuantity,
    @Semantics.amount.currencyCode: 'PurReqnItemCurrency'
    @DefaultAggregation: #SUM
    _Item.ItemNetAmount,
    @Semantics.amount.currencyCode: 'DisplayCurrency'
    @DefaultAggregation: #SUM
    currency_conversion(amount => _Item.ItemNetAmount, 
                        source_currency => _Item.PurReqnItemCurrency,
                        target_currency => $parameters.P_DisplayCurrency,
                         exchange_rate_date => _Item.CreationDate)
    as ItemNetAmountDispCurr,
    
    
    @Semantics.amount.currencyCode: 'InvDocCurrency'
    @DefaultAggregation: #SUM
    _ZI_MMPurOrdInvAmtQty.InvItemAmount,
    @Semantics.amount.currencyCode: 'DisplayCurrency'
    @DefaultAggregation: #SUM
    currency_conversion(amount => _ZI_MMPurOrdInvAmtQty.InvItemAmount, 
                        source_currency => _ZI_MMPurOrdInvAmtQty.DocumentCurrency,
                        target_currency => $parameters.P_DisplayCurrency,
                         exchange_rate_date => _Item.CreationDate)
    as InvAmountDispCurr,
    @Semantics.quantity.unitOfMeasure: 'InvBaseUnitOfMeasure'
    @DefaultAggregation: #SUM
    _ZI_MMPurOrdInvAmtQty.InvItemQuantity,
    
    _LastRelease.LastApprovedBy,
    _LastRelease.ApprovalDate,
    @EndUserText.label: 'Tvirtintojas'
    _LastRelease.ApproverName,
    
    
       
    
    /* Associations */
    _Item._CalcFields,
    _Item._Material,
    _Item._MaterialGroup,
    _Item._PurchaseOrder,
    _Item._PurchaseRequisition,
    _Item._PurchasingDocumentType,
    _Item._PurReqnAcctAssgmt,
    _Item._UnitOfMeasure
    
}
where (_Item.IsDeleted = '' or _Item.IsDeleted is null)
and _Item.CreationDate >= $parameters.P_StartDate
and _Item.CreationDate <= $parameters.P_EndDate
