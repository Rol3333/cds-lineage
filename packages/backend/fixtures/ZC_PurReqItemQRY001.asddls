@AbapCatalog.sqlViewName: 'ZCMMPRITMQ001'
@EndUserText.label: 'PIRKIMO PARAIŠKŲ ANALITINĖ ATASKAITA'
@AbapCatalog.compiler.compareFilter: true
@AbapCatalog.preserveKey: true
@AccessControl.authorizationCheck: #CHECK
@Analytics.query: true
@VDM.viewType: #CONSUMPTION
@Metadata.ignorePropagatedAnnotations: true
@ClientHandling.algorithm: #SESSION_VARIABLE 
define view ZC_PurReqItemQRY001 

 with parameters
    --@Environment.systemField: #SYSTEM_DATE
    @EndUserText.label: 'Laikotarpio pradžios data'
    @Consumption.derivation: { lookupEntity: 'I_CalendarDate', 
    resultElement: 'FirstDayofMonthDate', binding: [
    { targetElement : 'CalendarDate' , type : #SYSTEM_FIELD, value : '#SYSTEM_DATE' } ]
   }    
    P_Key1StartDate : vdm_v_key_date,
    
    @Environment.systemField: #SYSTEM_DATE
    @EndUserText.label: 'Laikotarpio pabaigos data'
    
    P_Key2EndDate : vdm_v_key_date,
    
     @Consumption.defaultValue: 'EUR'
     @Consumption.hidden: true
    P_DisplayCurrency           : displaycurrency,
    
    @Environment.systemField: #SYSTEM_DATE
    @Consumption.hidden: true
    P_Key3CurrentDate : vdm_v_key_date
    
as select from ZC_PurReqItemCube ( P_StartDate : :P_Key1StartDate, P_EndDate : :P_Key2EndDate, P_DisplayCurrency: :P_DisplayCurrency, P_CurrentDate: :P_Key3CurrentDate) {
    
    @AnalyticsDetails.query.hidden: true
    key PurchaseRequisition,
    @AnalyticsDetails.query.hidden: true
    key PurchaseRequisitionItem,
    
    
    @AnalyticsDetails.query.hidden: true
    @AnalyticsDetails.query.axis: #FREE
    @ObjectModel.foreignKey.association: '_CompanyCOde'
    @AnalyticsDetails.query.display: #TEXT
    @ObjectModel.text.element: ['CompanyCodeName']
    --@EndUserText.label: 'Balansinis vienetas'
    @Consumption.filter:{selectionType: #SINGLE, multipleSelections: true, mandatory: false}
    CompanyCode,
    @Semantics.text: true
    @EndUserText.label: 'Bal. Vnt. Pavadinimas'
    CompanyCOdeName,
    
    @AnalyticsDetails.query.hidden: true
    @ObjectModel.foreignKey.association: '_PurchasingOrganization'
    @Consumption.filter:{selectionType: #SINGLE, multipleSelections: true, mandatory: false}
    --@EndUserText.label: 'Perkančioji Organizacija'
    PurchasingOrganization,
    
    
    @ObjectModel.foreignKey.association: '_PurchasingGroup'
    @Consumption.filter:{selectionType: #SINGLE, multipleSelections: true, mandatory: false}
    @AnalyticsDetails.query.axis: #ROWS
    @AnalyticsDetails.query.totals: #SHOW 
    PurchasingGroup,
    
    @ObjectModel.foreignKey.association: '_PurchaseRequisition'
    @AnalyticsDetails.query.axis: #ROWS
    @Consumption.filter: { selectionType : #RANGE, multipleSelections: true, mandatory: false }
    @AnalyticsDetails.query.totals: #SHOW    
    PurchaseRequisitionNumber,
    
    @AnalyticsDetails.query.axis: #ROWS
    @EndUserText.label: 'Aprašymas'
    PurReqnHeaderDescription,
    
    @ObjectModel.foreignKey.association: '_PRCreateDate'
    @AnalyticsDetails.query.axis: #ROWS
    PRCreateDate,
    @ObjectModel.foreignKey.association: '_PRDeliveryDate'
    @AnalyticsDetails.query.axis: #ROWS
    PRDeliveryDate,
//    @ObjectModel.foreignKey.association: '_PRReleaseDate'
//    @AnalyticsDetails.query.axis: #ROWS
//    PRReleaseDate,
    @ObjectModel.foreignKey.association: '_PRApproveDate'
    @AnalyticsDetails.query.axis: #ROWS
    @EndUserText.label: 'Patvirtinimo data'
    cast(PurRecApproveDate as frgdt preserving type ) as PurRecApproveDate,
    
    @ObjectModel.foreignKey.association: '_PRCloseDate'
    @AnalyticsDetails.query.axis: #ROWS
    @EndUserText.label: 'Pirkimo įvykdymo data'
    CloseDate,
    
    @ObjectModel.foreignKey.association: '_PRExStartDate'
    @AnalyticsDetails.query.axis: #ROWS
    @EndUserText.label: 'Paraiškos registravimo vykdymui data'
    ExecutionStartDate,
    
    @ObjectModel.foreignKey.association: '_ProductGroup'
    @Consumption.filter:{selectionType: #SINGLE, multipleSelections: true, mandatory: false}
    @AnalyticsDetails.query.display: #KEY_TEXT 
    @AnalyticsDetails.query.axis: #ROWS
    ProductGroup,
    
    @ObjectModel.foreignKey.association: '_Product'
    @AnalyticsDetails.query.display: #KEY_TEXT 
    @Consumption.filter:{selectionType: #SINGLE, multipleSelections: true, mandatory: false}
    @AnalyticsDetails.query.axis: #ROWS
    Product,
    @AnalyticsDetails.query.axis: #ROWS
    @EndUserText.label: 'Medžiagos pavadinimas'
    PurchaseRequisitionItemText,
    
    @AnalyticsDetails.query.axis: #ROWS
    @EndUserText.label: 'Dokumentacija'
    DocumentList,
    
    @AnalyticsDetails.query.axis: #ROWS
    @EndUserText.label: 'Inicijuojantis asmuo'
    CreatedByUser,
    @AnalyticsDetails.query.axis: #ROWS
    @EndUserText.label: 'Inicijuojantis padalinys'
    orgUnitName,
    
    @ObjectModel.foreignKey.association: '_PRReleaseStatus'
    @Consumption.filter:{selectionType: #SINGLE, multipleSelections: true, mandatory: false}
    @AnalyticsDetails.query.axis: #ROWS
    @AnalyticsDetails.query.display: #TEXT 
    PurReqnReleaseStatus,
    _PRReleaseStatus,
    
    @Consumption.filter:{selectionType: #SINGLE, multipleSelections: true, mandatory: false}
    @AnalyticsDetails.query.axis: #ROWS
    IsClosed,
    
    @AnalyticsDetails.query.axis: #FREE
    Plant,
    _Plant,
    @AnalyticsDetails.query.axis: #FREE
    AccountAssignmentCategory,
    @AnalyticsDetails.query.axis: #FREE
    CostCenter,
    @AnalyticsDetails.query.axis: #FREE
    ProfitCenter,
    @AnalyticsDetails.query.axis: #FREE
    WBSElementInternalID,
    @AnalyticsDetails.query.axis: #FREE
    ProjectNetwork,
    @AnalyticsDetails.query.axis: #FREE
    Fund,
    @AnalyticsDetails.query.axis: #FREE
    FunctionalArea,
    @AnalyticsDetails.query.axis: #ROWS
    FundsCenter,
    @AnalyticsDetails.query.axis: #FREE
    CommitmentItemShortID,
    @AnalyticsDetails.query.axis: #FREE
    BudgetPeriod,
    @AnalyticsDetails.query.axis: #FREE
    MasterFixedAsset,
    @AnalyticsDetails.query.axis: #FREE
    FixedAsset,
    @AnalyticsDetails.query.axis: #FREE
    OrderID,
    @AnalyticsDetails.query.axis: #FREE
    @EndUserText.label: 'Iniciatorius'    
    UserFullName,
    @AnalyticsDetails.query.axis: #FREE
    RequisitionerName,
    @AnalyticsDetails.query.axis: #FREE
    PurchaseRequisitionType,
    @AnalyticsDetails.query.axis: #FREE
    LastApprovedBy,
    @AnalyticsDetails.query.axis: #FREE
    ApprovalDate,
    @AnalyticsDetails.query.axis: #FREE
    @EndUserText.label: 'Tvirtintojas'    
    ApproverName,
    
    -- UOMs and Currencies
    BaseUnit,
    InvBaseUnitOfMeasure,
    PurReqnItemCurrency,
    InvDocCurrency,
    DisplayCurrency,
    
    -- Key figures
    @EndUserText.label: 'Vykdymo trukmė'
    ExecutionInDays,
    @EndUserText.label: 'Vykdymo vėlavimas'
    DelayInDays,
    
    @EndUserText.label: 'Paraiškos kiekis'
    RequestedQuantity,
    @EndUserText.label: 'Paraiškos suma, Eur'
    ItemNetAmountDispCurr,
    @EndUserText.label: 'Įvykdymo kiekis'
    InvItemQuantity,
    @EndUserText.label: 'Įvykdymo suma, Eur'
    InvAmountDispCurr,
    @DefaultAggregation: #FORMULA
    @EndUserText.label: 'Sumos nuokrypis, Eur'
    @AnalyticsDetails.query.formula: 'InvAmountDispCurr - ItemNetAmountDispCurr'
    cast(0 as abap.curr( 15,  2 )) as ItemInvAmtDiff,
    @DefaultAggregation: #FORMULA
    @EndUserText.label: 'Nuokrypio procentas'
    @AnalyticsDetails.query.formula: '((InvAmountDispCurr - ItemNetAmountDispCurr) / ItemNetAmountDispCurr)*100'
    cast(0 as abap.dec( 4, 0 )) as ItemInvAmtDiffPerc,
    --OrderedQuantity,
    --PurchaseRequisitionPrice,
    --PurReqnPriceQuantity,
    --IsPurReqnBlocked,
    --PurReqnItemBlockingReasonText,
    --PurchaseOrderDate,
    --CommitmentItem,
    --FundsCenter,
    --MaterialOrderUnit,
    --CostCenter,
    --PurReqnExternalReference,
    --PurReqnItemExternalReference,
    
    -- Associations

    _CompanyCode,
    _InvCurrency,

    _PRCreateDate,
    _PRDeliveryDate,
    _Product,
    _ProductGroup,
//    _PRReleaseDate,
    _PurchaseRequisition,
    _PurchasingGroup,
    _PurchasingOrganization,
    _PurReqItemCurrency,
    _PurReqnAcctAssgmt

}

