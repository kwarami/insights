# Copyright (c) 2025, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

from contextlib import contextmanager

import frappe
import ibis
from frappe.model.document import Document
from ibis import _

from insights.decorators import insights_whitelist
from insights.insights.doctype.insights_data_source_v3.ibis_utils import (
    IbisQueryBuilder,
    execute_ibis_query,
    get_columns_from_schema,
)


class InsightsQueryv3(Document):
    # begin: auto-generated types
    # This code is auto-generated. Do not modify anything in this block.

    from typing import TYPE_CHECKING

    if TYPE_CHECKING:
        from frappe.types import DF

        is_builder_query: DF.Check
        is_native_query: DF.Check
        is_script_query: DF.Check
        linked_queries: DF.JSON | None
        old_name: DF.Data | None
        operations: DF.JSON | None
        title: DF.Data | None
        use_live_connection: DF.Check
        workbook: DF.Link
    # end: auto-generated types

    def get_valid_dict(self, *args, **kwargs):
        if isinstance(self.operations, list):
            self.operations = frappe.as_json(self.operations)
        if isinstance(self.linked_queries, list):
            self.linked_queries = frappe.as_json(self.linked_queries)
        return super().get_valid_dict(*args, **kwargs)

    def before_save(self):
        self.set_linked_queries()

    def set_linked_queries(self):
        operations = frappe.parse_json(self.operations)
        if not operations:
            return

        linked_queries = []
        for operation in operations:
            if (
                operation.get("table")
                and operation.get("table").get("type") == "query"
                and operation.get("table").get("query_name")
            ):
                linked_queries.append(operation.get("table").get("query_name"))
        self.linked_queries = linked_queries

    def build(self, active_operation_idx=None, use_live_connection=None):
        operations = frappe.parse_json(self.operations)

        if (
            active_operation_idx is not None
            and active_operation_idx >= 0
            and active_operation_idx < len(operations)
        ):
            operations = operations[: active_operation_idx + 1]

        if (
            hasattr(frappe.local, "insights_adhoc_filters")
            and self.name in frappe.local.insights_adhoc_filters
        ):
            adhoc_filters = frappe.local.insights_adhoc_filters[self.name]
            if (
                adhoc_filters
                and isinstance(adhoc_filters, dict)
                and adhoc_filters.get("type") == "filter_group"
                and adhoc_filters.get("filters")
            ):
                operations.append(adhoc_filters)

        use_live_connection = use_live_connection or self.use_live_connection
        ibis_query = IbisQueryBuilder().build(self)

        if ibis_query is None:
            frappe.throw("Failed to build query")

        return ibis_query

    @frappe.whitelist()
    def execute(self, active_operation_idx=None, adhoc_filters=None):
        with set_adhoc_filters(adhoc_filters):
            ibis_query = self.build(active_operation_idx)

        limit = 100
        for op in frappe.parse_json(self.operations):
            if op.get("limit"):
                limit = op.get("limit")
                break

        results, time_taken = execute_ibis_query(
            ibis_query, limit, cache_expiry=60 * 10
        )
        results = results.to_dict(orient="records")

        columns = get_columns_from_schema(ibis_query.schema())
        return {
            "sql": ibis.to_sql(ibis_query),
            "columns": columns,
            "rows": results,
            "time_taken": time_taken,
        }

    @insights_whitelist()
    def get_count(self, active_operation_idx=None):
        ibis_query = self.build(active_operation_idx)
        count_query = ibis_query.aggregate(count=_.count())
        count_results, time_taken = execute_ibis_query(count_query, cache_expiry=60 * 5)
        total_count = count_results.values[0][0]
        return int(total_count)

    @insights_whitelist()
    def download_results(self, active_operation_idx=None):
        ibis_query = self.build(active_operation_idx)
        results, time_taken = execute_ibis_query(
            ibis_query, cache=False, limit=10_00_000
        )
        return results.to_csv(index=False)

    @insights_whitelist()
    def get_distinct_column_values(
        self, column_name, active_operation_idx=None, search_term=None, limit=20
    ):
        ibis_query = self.build(active_operation_idx)
        values_query = (
            ibis_query.select(column_name)
            .filter(
                getattr(_, column_name).notnull()
                if not search_term
                else getattr(_, column_name).ilike(f"%{search_term}%")
            )
            .distinct()
            .head(limit)
        )
        result, time_taken = execute_ibis_query(values_query, cache_expiry=24 * 60 * 60)
        return result[column_name].tolist()

    @insights_whitelist()
    def get_columns_for_selection(self, active_operation_idx=None):
        ibis_query = self.build(active_operation_idx)
        columns = get_columns_from_schema(ibis_query.schema())
        return columns


@contextmanager
def set_adhoc_filters(filters):
    frappe.local.insights_adhoc_filters = filters or {}
    yield
    frappe.local.insights_adhoc_filters = None
